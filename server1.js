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

app.use(express.static('public'));
app.use(express.json());

const imageMap = {
    "mysql": "mysql",
    "postgresql": "postgres",
    "mongodb": "mongo",
    "mariadb": "mariadb",
    "apache-couchdb": "couchdb",
    "zeromq": "zeromq",
    "activemq": "rmohr/activemq",
    "kafka": "bitnami/kafka",
    "rabbitmq": "rabbitmq",
    "elasticsearch": "elasticsearch"
};

app.post("/deploy-service", async (req, res) => {
    const { servicetype, serviceName, dbName, username, password } = req.body;


    if (!servicetype || !serviceName || !dbName || !username || !password) {
        return res.status(400).json({ message: "Missing required fields!" });
    }

    const imageName = imageMap[servicetype.toLowerCase()];

    if (!imageName) {
        return res.status(400).json({ message: `Invalid service type: ${servicetype}` });
    }

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);
        const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

        const templateFilePath = path.join(__dirname, "yaml", "deployment.yaml");

        const yamlContent = fs.readFileSync(templateFilePath, "utf8")
            .replace(/{{SERVICE__NAME}}/g, serviceName)
            .replace(/{{IMAGE_NAME}}/g, imageName)
            .replace(/{{db_name}}/g, dbName)
            .replace(/{{username}}/g, username)
            .replace(/{{password}}/g, password);

       const newYamlFilePath = path.join(__dirname, "yaml", `${seriveName}.yaml`);
       fs.writeFileSync(newYamlFilePath, yamlContent);
       console.log(`Generated YAML File: ${newYamlFilePath}`);

        const yamlObjects = yaml.loadAll(yamlContent);
        const results = [];

         for (const resource of yamlObjects) {
            try {
                if (resource.kind === "Deployment") {
                    // Check if Deployment already exists
                    try {
                        await k8sApi.readNamespacedDeployment(resource.metadata.name, "default");
                        // If exists, update it using PATCH
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
                        if (err.statusCode === 404) {
                            // If not found, create it
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


app.listen(3000, "0.0.0.0", () => {

