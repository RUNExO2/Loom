const http = require('http');

function check() {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:9222/json/version', (res) => {
            if (res.statusCode === 200) resolve(true);
            else resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

(async () => {
    let attempts = 0;
    while (attempts < 120) {
        if (await check()) {
            console.log("CDP ready!");
            process.exit(0);
        }
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
    }
    console.log("Timeout waiting for CDP");
    process.exit(1);
})();
