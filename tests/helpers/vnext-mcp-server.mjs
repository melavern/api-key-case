// Synthetic metadata only; no OS store, values, native approval or writes.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVNextTools } from "../../dist/mcp/vnext.js";
import { validate, catalogSchema, operationSchema } from "../../dist/core/vnext/model.js";
const [project, metadata] = process.argv.slice(2);
const current = () => JSON.parse(readFileSync(metadata, "utf8"));
const store = { readCatalog: () => ({ catalog: validate(catalogSchema, current().catalog) }),
  readOperation: id => { const op = current().operation; return op?.operationId === id ? { operation: validate(operationSchema, op) } : null; },
  listUseOperations: () => [], listLaunchOperations: () => [] };
const server = new McpServer({ name: "synthetic-vnext-chat", version: "1" });
registerVNextTools(server, project, { store, presence: async () => "present", legacy: async () => ({ status: "available", locators: [] }), backend: async () => "available" });
await server.connect(new StdioServerTransport());
