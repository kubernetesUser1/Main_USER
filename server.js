import * as k8s from '@kubernetes/client-node';
import express from 'express';
import { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';


const app = express();
const port = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static('public')); // Serve HTML & JS from public folder
app.use(express.json()); // Parse JSON requests

// API to deploy database service
app.post('/deploy-service', async (req, res) => {
    const { serviceName, dbName, dbPort, dbUsername, dbPassword, replicas } = req.body;

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.KubernetesObjectApi);

        const yamlFilePath = path.join(__dirname, 'yaml', 'deployment.yaml');

        // Check if file exists
        if (!fs.existsSync(yamlFilePath)) {
            return res.status(404).json({ message: "YAML template not found." });
        }

        let yamlContent = fs.readFileSync(yamlFilePath, 'utf8');

        // Replace placeholders with user input
        yamlContent = yamlContent
            .replace(/{{SERVICE_NAME}}/g, serviceName)
            .replace(/{{DB_NAME}}/g, dbName)
            .replace(/{{DB_USERNAME}}/g, dbUsername)
            .replace(/{{DB_PASSWORD}}/g, dbPassword)
            .replace(/{{DB_PORT}}/g, dbPort)
            .replace(/{{REPLICAS}}/g, replicas);

        // Parse updated YAML
        const yamlObjects = yaml.loadAll(yamlContent);

        // Deploy resources to Kubernetes
        const results = [];
        for (const resource of yamlObjects) {
            try {
                const result = await k8sApi.create(resource);
                results.push({ status: 'created', resource: resource.metadata.name });
            } catch (err) {
                results.push({ status: 'error', error: err.message });
            }
        }

        res.json({ message: 'Deployment completed', results });
    } catch (err) {
        console.error('Deployment error:', err);
        res.status(500).json({ message: 'Failed to deploy service', error: err.message });
    }
});
app.delete('/delete-service', async (req, res) => {
    const { serviceName } = req.body;

    try {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const k8sApi = kc.makeApiClient(k8s.AppsV1Api);
        const coreApi = kc.makeApiClient(k8s.CoreV1Api);

        console.log(`Attempting to delete deployment: ${serviceName}-deployment`);
        console.log(`Attempting to delete service: ${serviceName}-service`);

        // Delete Deployment
        await k8sApi.deleteNamespacedDeployment(`${serviceName}-deployment`, 'default');
        
        // Delete Service
        await coreApi.deleteNamespacedService(`${serviceName}-service`, 'default');

        res.json({ message: `Service ${serviceName} deleted successfully!` });

    } catch (err) {
        console.error("Error deleting service:", err);
        res.status(500).json({ message: 'Failed to delete service', error: err.message });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});


