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
    "activemq": "rmohr/activemq",
    "kafka": "bitnami/kafka",
    "rabbitmq": "rabbitmq",
    "elasticsearch": "bitnami/elasticsearch"
};

app.post("/deploy-service", async (req, res) => {
    const { selectedApplication, applicationName, dbName, username, password, rootPassword, postgresPassword,serviceType, portNumber } = req.body;

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
            .replace(/{{PASSWORD}}/g, password)
            .replace(/{{SERVICE_TYPE}}/g, serviceType || "ClusterIP")
            .replace(/{{PORT_NUMBER}}/g, portNumber || "");  // Optional fallback



        if (selectedApplication === "mysql" || selectedApplication === "mariadb") {
            yamlContent = yamlContent.replace(/{{ROOT_PASSWORD}}/g, rootPassword || "");
        } else if (selectedApplication === "postgresql") {
            yamlContent = yamlContent.replace(/{{POSTGRES_PASSWORD}}/g, postgresPassword || "");
        } else if (selectedApplication === "kafka") {
            yamlContent = yamlContent
                .replace(/{{ZOOKEEPER_CONNECT}}/g, "zookeeper:2181")
                .replace(/{{KAFKA_LISTENERS}}/g, "PLAINTEXT://:9092")
                .replace(/{{KAFKA_ADVERTISED_LISTENERS}}/g, `PLAINTEXT://${applicationName}:9092`)
                .replace(/{{ALLOW_PLAINTEXT_LISTENER}}/g, "yes");
        } else if (selectedApplication === "elasticsearch") {
            yamlContent = yamlContent
                .replace(/{{DISCOVERY_TYPE}}/g, "single-node")
                .replace(/{{ES_JAVA_OPTS}}/g, "-Xms512m -Xmx512m")
                .replace(/{{MEMORY_REQUEST}}/g, "1Gi")
                .replace(/{{CPU_REQUEST}}/g, "500m")
                .replace(/{{MEMORY_LIMIT}}/g, "2Gi")
                .replace(/{{CPU_LIMIT}}/g, "1000m");
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

app.get("/api/deployments", async (req, res) => {
    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApiApps = kc.makeApiClient(k8s.AppsV1Api);
        const k8sApiCore = kc.makeApiClient(k8s.CoreV1Api);


        const deploymentsResponse = await k8sApiApps.listNamespacedDeployment("default");
        const deployments = deploymentsResponse.body.items;

        const filteredDeployments = deployments.filter(deploy => 
            deploy.metadata.labels && deploy.metadata.labels.createdBy === "custom-ui"
        );

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

app.delete("/api/deployments/:name", async (req, res) => {
    const { name } = req.params;

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApiApps = kc.makeApiClient(k8s.AppsV1Api);

        const deployments = await k8sApiApps.listNamespacedDeployment("default");
        const deploymentNames = deployments.body.items.map(dep => dep.metadata.name);

        if (!deploymentNames.includes(name)) {
            return res.status(404).json({ message: `Deployment ${name} not found` });
        }

        await k8sApiApps.deleteNamespacedDeployment(name, "default");
        console.log(` Successfully deleted deployment: ${name}`);

        res.status(200).json({ message: `Deployment ${name} deleted successfully` });
    } catch (err) {
        console.error("Error deleting deployment:", err);
        res.status(500).json({ message: "Failed to delete deployment", error: err.message });
    }
});

app.post('/api/deployments/:name/scale', async (req, res) => {
    try {
        console.log('Scaling Request:', req.body);

        const { replicas } = req.body;
        const deploymentName = req.params.name;

        if (!deploymentName || replicas === undefined) {
            return res.status(400).json({ message: 'Deployment name and replicas are required.' });
        }

        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);

        const namespace = 'default';

        const deployment = await k8sApi.readNamespacedDeployment(deploymentName, namespace);

        deployment.body.spec.replicas = parseInt(replicas, 10);

        await k8sApi.replaceNamespacedDeployment(deploymentName, namespace, deployment.body);

        res.status(200).json({
            message: `Deployment '${deploymentName}' scaled to ${replicas} replicas successfully.`,
        });
    } catch (error) {
        console.error(`Error scaling deployment ${req.params.name}:`, error);
        res.status(500).json({
            message: `Error scaling deployment ${req.params.name}`,
            error: error.message,
        });
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
            const podIP = pod.status.podIP || "N/A";

            return {
                name: pod.metadata.name,
                status: pod.status.phase,
                restarts: restarts,
                age: timeAgo(pod.metadata.creationTimestamp),
                podIP: podIP,
                podStatus: `${readyContainers}/${totalContainers}`
            };
        });

        res.json(pods);
    } catch (err) {
        console.error("Error fetching pods:", err);
        res.status(500).json({ message: "Failed to fetch pods", error: err.message });
    }
});

app.get("/api/pods/:podName/logs", async (req, res) => {
    try {
        const podName = req.params.podName;
        const namespace = req.query.namespace || "default"; // Get namespace from request

        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

        console.log(`Fetching logs for Pod: ${podName}, Namespace: ${namespace}`);

        const logResponse = await k8sApi.readNamespacedPodLog(podName, namespace);
        res.send(logResponse.body || "No logs available.");
    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ message: "Failed to fetch logs", error: error.message });
    }
});

function timeAgo(timestamp) {
    const currentTime = new Date().getTime(); // browser time
    const podTime = new Date(timestamp).getTime(); // UTC from cluster

    let timeDiff = (currentTime - podTime) / 1000;

    // Prevent negative values
    if (timeDiff < 0) timeDiff = 0;

    if (timeDiff < 60) return `${Math.floor(timeDiff)} seconds ago`;
    if (timeDiff < 3600) return `${Math.floor(timeDiff / 60)} minutes ago`;
    if (timeDiff < 86400) return `${Math.floor(timeDiff / 3600)} hours ago`;
    return `${Math.floor(timeDiff / 86400)} days ago`;
}



app.get("/api/replication-controllers", async (req, res) => {
    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault(); // Load the kubeconfig file from default location
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);  // Using AppsV1Api for Deployments

        const namespace = "default";  // You can change this if needed
        const response = await k8sApi.listNamespacedDeployment(namespace);  // Fetch deployments

        const controllers = response.body.items.map((item) => ({
            name: item.metadata?.name || "-",
            labels: item.metadata?.labels || {},
            pods: {
                ready: item.status?.readyReplicas || 0,
                total: item.status?.replicas || 0,
            },
            createdTime: item.metadata?.creationTimestamp || "-",
            images: item.spec?.template?.spec?.containers?.map((c) => c.image) || [],
        }));

        res.json(controllers);  // Send back the deployment data as JSON
    } catch (error) {
        console.error("Error fetching replication controllers:", error.message);
        res.status(500).json({ error: "Failed to fetch replication controllers" });
    }
});

app.listen(3003, "0.0.0.0", () => {
    console.log("Server running on port 3000...");
});

