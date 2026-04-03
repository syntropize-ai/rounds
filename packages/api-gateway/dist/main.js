// API Gateway process entry point - calls startServer()
import { startServer } from './server.js';
const port = parseInt(process.env['PORT'] ?? '3000', 10);
startServer(port);
//# sourceMappingURL=main.js.map