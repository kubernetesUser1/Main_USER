import * as k8s from '@kubernetes/client-node';
import express from 'express';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/:filename", (req, res) => {
    const filePath = path.join(__dirname, "public", req.params.filename);
    res.sendFile(filePath);
});

const imageMap = {
    "mysql": "mysql",
    "postgresql": "postgres",
    "mongodb": "mongo",
    "mariadb": "mariadb",
    "apache-couchdb": "couchdb",
    "zeromq": "jpillora/zeromq",
    "activemq": "rmohr/activemq",
    "kafka": "bitnami/kafka",
    "rabbitmq": "rabbitmq",
    "elasticsearch": "elasticsearch"
};

app.post("/deploy-service", async (req, res) => {
    const { selectApplication, applicationName, dbName, username, password} = req.body;


    if (!selectApplication || !applicationName || !dbName || !username || !password) {
        return res.status(400).json({ message: "Missing required fields!" });
    }

    const imageName = imageMap[selectApplication.toLowerCase()];

    if (!imageName) {
        return res.status(400).json({ message: `Invalid select application: ${selectApplication}` });
    }

    //let extraEnvVars = "";
   // if (selectApplication.toLowerCase() === "mysql" || selectApplication.toLowerCase() === "mariadb") {
     //   extraEnvVars = `- name: MYSQL_ROOT_PASSWORD\n  value: "${password}"`;
   // } else if (selectApplication.toLowerCase() === "postgres") {
     //   extraEnvVars = `- name: POSTGRES_PASSWORD\n  value: "${password}"`;
  //  }

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);
        const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

        const templateFilePath = path.join(__dirname, "yaml", "deployment.yaml");
        const yamlContent = fs.readFileSync(templateFilePath, "utf8")
            .replace(/{{APPLICATION_NAME}}/g, applicationName)
            .replace(/{{IMAGE_NAME}}/g, imageName)
            .replace(/{{DB_NAME}}/g, dbName)
            .replace(/{{DB_USER}}/g, username)
            .replace(/{{DB_PASSWORD}}/g, password)
            .replace(/{{EXTRA_ENV_VARS}}/g, extraEnvVars);

        const newYamlFilePath = path.join(__dirname, "yaml", `${applicationName}.yaml`);
        fs.writeFileSync(newYamlFilePath, yamlContent);
        console.log(`Generated YAML File: ${newYamlFilePath}`);

        const yamlObjects = yaml.loadAll(yamlContent);
        const results = [];

        for (const resource of yamlObjects) {
            try {
                if (resource.kind === "Deployment") {
                    try {
                        await k8sApi.readNamespacedDeployment(resource.metadata.name, "default");
                        await k8sApi.patchNamespacedDeployment(
                            resource.metadata.name,
                            "default",
                            resource,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            { headers: { 'Content-Type': 'application/merge-patch+json' } }
                        );
                        results.push({ status: "updated", resource: resource.metadata.name });
                    } catch (err) {
                        if (err.response?.statusCode === 404) {
                            await k8sApi.createNamespacedDeployment("default", resource);
                            results.push({ status: "created", resource: resource.metadata.name });
                        } else {
                            throw err;
                        }
                    }
                } else if (resource.kind === "Service") {
                    try {
                        await k8sCoreApi.readNamespacedService(resource.metadata.name, "default");
                        await k8sCoreApi.patchNamespacedService(
                            resource.metadata.name,
                            "default",
                            resource,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            { headers: { 'Content-Type': 'application/merge-patch+json' } }
                        );
                        results.push({ status: "updated", resource: resource.metadata.name });
                    } catch (err) {
                        if (err.response?.statusCode === 404) {
                            await k8sCoreApi.createNamespacedService("default", resource);
                            results.push({ status: "created", resource: resource.metadata.name });
                        } else {
                            throw err;
                        }
                    }
                }
            } catch (err) {
                console.error(`Error processing resource ${resource.kind}:`, err);
                results.push({ status: "error", error: err.message });
            }
        }

        res.json({ message: "Deployment applied successfully", results, redirectTo: `/deploy.html?application=${applicationName}` });
    } catch (err) {
        console.error("Error applying deployment:", err);
        res.status(500).json({ message: "Failed to apply deployment", error: err.message });
    }
});


app.get("/api/deployments", async (req, res) => {
    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApiApps = kc.makeApiClient(k8s.AppsV1Api);
        const k8sApiCore = kc.makeApiClient(k8s.CoreV1Api);


        const deploymentsResponse = await k8sApiApps.listNamespacedDeployment("default");
        const deployments = deploymentsResponse.body.items;


        const podsResponse = await k8sApiCore.listNamespacedPod("default");
        const allPods = podsResponse.body.items;

        const deploymentsData = deployments.map(deploy => {
            const deploymentName = deploy.metadata.name;

            const relatedPods = allPods.filter(pod =>
                pod.metadata.ownerReferences &&
                pod.metadata.ownerReferences.some(ref => ref.kind === "ReplicaSet" && ref.name.includes(deploymentName))
            );


            const totalPods = relatedPods.length;
            const readyPods = relatedPods.filter(pod =>
                pod.status.containerStatuses &&
                pod.status.containerStatuses.every(cs => cs.ready)
            ).length;

            return {
                name: deploymentName,
                labels: deploy.metadata.labels,
                createdTime: deploy.metadata.creationTimestamp,
                image: deploy.spec.template.spec.containers[0].image,
                pods: { ready: readyPods, total: totalPods }
            };
        });

        res.json(deploymentsData);
    } catch (err) {
        console.error("Error fetching deployments:", err);
        res.status(500).json({ message: "Failed to fetch deployments", error: err.message });
    }
});


app.get("/api/pods", async (req, res) => {
    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

        const response = await k8sApi.listNamespacedPod("default");

        const pods = response.body.items.map(pod => {
            const containerStatuses = pod.status.containerStatuses || [];
            const readyContainers = containerStatuses.filter(cs => cs.ready).length;
            const totalContainers = containerStatuses.length;
            const restarts = containerStatuses.length > 0 ? containerStatuses[0].restartCount : 0;
            const clusterIP = pod.status.podIP || "N/A";

            return {
                name: pod.metadata.name,
                status: pod.status.phase,
                restarts: restarts,
                age: timeAgo(pod.metadata.creationTimestamp),
                clusterIP: clusterIP,
                podStatus: `${readyContainers}/${totalContainers}`
            };
        });

        res.json(pods);
    } catch (err) {
        console.error("Error fetching pods:", err);
        res.status(500).json({ message: "Failed to fetch pods", error: err.message });
    }
});


function timeAgo(date) {
    const diff = Math.floor((new Date() - new Date(date)) / 1000);
    if (diff < 60) return `${diff} seconds ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
     return `${Math.floor(diff / 86400)} days ago`;
}

   app.listen(3000, "0.0.0.0", () => {
    console.log("Server running on port 3000...");
});

