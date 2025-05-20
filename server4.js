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

let userDeployedApps = [];

app.post("/deploy-service", async (req, res) => {
    const { selectedApplication, applicationName, dbName, username, password, rootPassword, postgresPassword } = req.body;

    if (!selectedApplication || !applicationName || !dbName || !username || !password) {
        return res.status(400).json({ message: "Missing required fields!" });
    }

    const imageName = imageMap[selectedApplication.toLowerCase()];
    if (!imageName) {
        return res.status(400).json({ message: `Invalid application type: ${selectedApplication}` });
    }

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);
        const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

        const templateFilePath = path.join(__dirname, "yaml", "deployment.yaml");
        let yamlContent = fs.readFileSync(templateFilePath, "utf8")
            .replace(/{{APPLICATION_NAME}}/g, applicationName)
            .replace(/{{IMAGE_NAME}}/g, imageName)
            .replace(/{{DB_NAME}}/g, dbName)
            .replace(/{{USERNAME}}/g, username)
            .replace(/{{PASSWORD}}/g, password);

        // Handle specific database passwords
        if (selectedApplication === "mysql" || selectedApplication === "mariadb") {
            yamlContent = yamlContent.replace(/{{ROOT_PASSWORD}}/g, rootPassword || "");
        } else if (selectedApplication === "postgresql") {
            yamlContent = yamlContent.replace(/{{POSTGRES_PASSWORD}}/g, postgresPassword || "");
        }

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
                            resource.metadata.name, "default", resource, undefined, undefined, undefined, undefined,
                            { headers: { 'Content-Type': 'application/merge-patch+json' } }
                        );
                        results.push({ status: "updated", resource: resource.metadata.name });
                    } catch (err) {
                        if (err.statusCode === 404) {
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
                            resource.metadata.name, "default", resource, undefined, undefined, undefined, undefined,
                            { headers: { 'Content-Type': 'application/merge-patch+json' } }
                        );
                        results.push({ status: "updated", resource: resource.metadata.name });
                    } catch (err) {
                        if (err.statusCode === 404) {
                            await k8sCoreApi.createNamespacedService("default", resource);
                            results.push({ status: "created", resource: resource.metadata.name });
                        } else {
                            throw err;
                        }
                    }
                }
            } catch (err) {
                results.push({ status: "error", error: err.message });
            }
        }

        res.json({ message: "Deployment applied successfully", results });
    } catch (err) {
        console.error("Error applying deployment:", err);
        res.status(500).json({ message: "Failed to apply deployment", error: err.message });
    }
});

app.post("/api/deployments", async (req, res) => {
    try {
        const { name, image, labels } = req.body;

        const deploymentManifest = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name },
            spec: {
                replicas: 1,
                selector: { matchLabels: labels },
                template: {
                    metadata: { labels },
                    spec: { containers: [{ name, image }] }
                }
            }
        };

        await k8sApiApps.createNamespacedDeployment("default", deploymentManifest);
        console.log(`Deployed: ${name}`);

        userDeployedApps.push(name); // ✅ Store deployment name

        res.status(201).json({ 
            message: `Deployment ${name} created successfully`, 
            redirect: "/deployment.html" 
        });
    } catch (err) {
        console.error("Error deploying application:", err);
        res.status(500).json({ message: "Deployment failed", error: err.message });
    }
});

// ✅ Get user-created deployments
app.get("/api/deployments", async (req, res) => {
    try {
        const deploymentsResponse = await k8sApiApps.listNamespacedDeployment("default");
        let allDeployments = deploymentsResponse.body.items;

        // ✅ Filter only deployments created via deploy.html
        const filteredDeployments = allDeployments.filter(deploy => 
            userDeployedApps.includes(deploy.metadata.name)
        );

        const deploymentsData = filteredDeployments.map(deploy => ({
            name: deploy.metadata.name,
            labels: deploy.metadata.labels || {},
            createdTime: deploy.metadata.creationTimestamp,
            image: deploy.spec.template.spec.containers[0].image,
            pods: { ready: 1, total: 1 } // ✅ Adjust this to fetch real pod data
        }));

        res.json(deploymentsData);
    } catch (err) {
        console.error("Error fetching deployments:", err);
        res.status(500).json({ message: "Failed to fetch deployments", error: err.message });
    }
});

// ✅ Delete a deployment
app.delete("/api/deployments/:name", async (req, res) => {
    const { name } = req.params;

    try {
        await k8sApiApps.deleteNamespacedDeployment(name, "default");
        console.log(`Deleted deployment: ${name}`);

        userDeployedApps = userDeployedApps.filter(deployName => deployName !== name);

        res.status(200).json({ message: `Deployment ${name} deleted successfully` });
    } catch (err) {
        console.error("Error deleting deployment:", err);
        res.status(500).json({ message: "Failed to delete deployment", error: err.message });
    }
});

// ✅ Scale a deployment
app.post("/api/deployments/:name/scale", async (req, res) => {
    const { name } = req.params;
    const { replicas } = req.body;

    try {
        const scaleManifest = {
            apiVersion: "apps/v1",
            kind: "Scale",
            metadata: { name, namespace: "default" },
            spec: { replicas }
        };

        await k8sApiApps.patchNamespacedDeploymentScale(name, "default", scaleManifest, undefined, undefined, undefined, undefined, {
            headers: { "Content-Type": "application/merge-patch+json" }
        });

        console.log(`Scaled deployment: ${name} to ${replicas} replicas`);
        res.status(200).json({ message: `Deployment ${name} scaled to ${replicas} replicas` });
    } catch (err) {
        console.error("Error scaling deployment:", err);
          res.status(500).json({ message: "Failed to scale deployment", error: err.message });
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


app.listen(3001, "0.0.0.0", () => {
    console.log("Server running on port 3000...");
});
