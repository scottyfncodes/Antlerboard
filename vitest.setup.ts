import { config } from "dotenv";

// Point the test run at the dedicated test database instead of dev data.
config({ path: ".env.test", override: true });
