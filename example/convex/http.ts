import { httpRouter } from "convex/server";
import { linq } from "./linq.js";

const http = httpRouter();

// POST https://<deployment>.convex.site/linq/webhook
linq.registerRoutes(http);

export default http;
