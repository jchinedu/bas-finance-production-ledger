import 'dotenv/config';
import { startServer } from './app.js';

startServer().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
