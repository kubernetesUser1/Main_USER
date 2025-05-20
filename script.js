document.getElementById("deploy-form").addEventListener("submit", function(event) {
    event.preventDefault();
    const serviceName = document.getElementById("service-name").value;
    const dbName = document.getElementById("db-name").value;  // Capture DB_NAME

    fetch("/deploy-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName, dbName })  // Send DB_NAME
    })
    .then(response => response.json())
    .then(data => {
        alert(data.message || "Deployment successful!");
    })
    .catch(error => {
        console.error("Error:", error);
        alert("Deployment failed!");
    });
});
