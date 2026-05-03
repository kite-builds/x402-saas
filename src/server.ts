import express, { type Request, type Response } from "express";
import { resolve } from "node:path";
import { SaasDb } from "./db.js";
import { controlPlaneRouter } from "./control-plane.js";
import { dataPlaneRouter } from "./data-plane.js";
import {
  HttpFacilitator,
  STUB_FACILITATOR,
  DEFAULT_FACILITATOR_URL,
  type FacilitatorClient,
} from "./facilitator.js";

const port = Number(process.env.PORT ?? 4000);
const domain = process.env.X402_SAAS_DOMAIN ?? "localhost";
const dbPath = process.env.X402_SAAS_DB ?? resolve(process.cwd(), "x402-saas.db");
const feeWallet = process.env.X402_SAAS_FEE_WALLET ?? "0xfee0000000000000000000000000000000000000";
const facilitatorUrl = process.env.X402_SAAS_FACILITATOR_URL ?? "";
const facilitator: FacilitatorClient =
  facilitatorUrl === "stub" || facilitatorUrl === ""
    ? STUB_FACILITATOR
    : new HttpFacilitator(facilitatorUrl === "default" ? DEFAULT_FACILITATOR_URL : facilitatorUrl);

const db = new SaasDb(dbPath);

const app = express();
app.disable("x-powered-by");

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "x402-saas",
    powered_by: "x402-kit",
    docs: "/docs",
    apis: {
      control: "/api/v1/*",
      data: `*.${domain}/*`,
    },
    fee_treasury: feeWallet,
  });
});

app.get("/__x402/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use("/api/v1", controlPlaneRouter({ db, domain }));
app.use(
  dataPlaneRouter({
    db,
    domain,
    feeWallet,
    enforceHostMatch: process.env.NODE_ENV === "production",
    facilitator,
  }),
);

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`x402-saas listening on http://localhost:${port}`);
  console.log(`  domain: ${domain}`);
  console.log(`  db:     ${dbPath}`);
  console.log(`  fee:    ${feeWallet}`);
  console.log(
    `  facilitator: ${facilitator === STUB_FACILITATOR ? "stub (dev)" : facilitatorUrl === "default" ? DEFAULT_FACILITATOR_URL : facilitatorUrl}`,
  );
});

const shutdown = (): void => {
  server.close();
  db.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
