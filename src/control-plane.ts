import express, { type Request, type Response, type NextFunction, type Router } from "express";
import { isAddress, type Hex } from "viem";
import { SaasDb, type Tenant } from "./db.js";
import { deriveSlug, validateSlug } from "./slug.js";
import {
  makeChallenge,
  challengeToMessage,
  verifyChallengeSignature,
  type SiweChallenge,
} from "./auth.js";

export interface ControlPlaneOptions {
  db: SaasDb;
  domain: string;
}

interface CreateTenantBody {
  challenge: SiweChallenge;
  signature: Hex;
  network: "base" | "base-sepolia";
  routes: Array<{
    method: string;
    path: string;
    priceUsd: string;
    description?: string;
    backendUrl: string;
  }>;
  preferredSlug?: string;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH_RE = /^\/[A-Za-z0-9_\-./]{0,200}$/;
const PRICE_RE = /^\d+(\.\d{1,6})?$/;

export function controlPlaneRouter(opts: ControlPlaneOptions): Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));

  router.post("/auth/challenge", (req: Request, res: Response) => {
    const wallet = String(req.body?.walletAddress ?? "");
    if (!isAddress(wallet)) {
      return res.status(400).json({ error: "invalid_wallet" });
    }
    const challenge = makeChallenge(wallet, opts.domain);
    res.json({ challenge, message: challengeToMessage(challenge) });
  });

  router.post("/tenants", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as CreateTenantBody;
      if (!body?.challenge || !body?.signature) {
        return res.status(400).json({ error: "missing_signature" });
      }

      const sigOk = await verifyChallengeSignature(body.challenge, body.signature);
      if (!sigOk.ok) {
        return res.status(401).json({ error: "auth_failed", reason: sigOk.reason });
      }

      if (body.network !== "base" && body.network !== "base-sepolia") {
        return res
          .status(400)
          .json({ error: "invalid_network", reason: "use 'base' or 'base-sepolia'" });
      }

      if (!Array.isArray(body.routes) || body.routes.length === 0 || body.routes.length > 20) {
        return res.status(400).json({
          error: "invalid_routes",
          reason: "send 1-20 routes",
        });
      }

      const validatedRoutes = body.routes.map((r, i) => validateRouteInput(r, i));

      const existing = opts.db.getTenantByWallet(sigOk.address);
      if (existing) {
        return res.status(409).json({
          error: "wallet_already_registered",
          tenantId: existing.id,
          slug: existing.slug,
        });
      }

      const slug = chooseSlug(opts.db, body.preferredSlug, sigOk.address);

      const tenant = opts.db.createTenant({
        walletAddress: sigOk.address,
        slug,
        network: body.network,
      });
      for (const r of validatedRoutes) {
        opts.db.addRoute({ tenantId: tenant.id, ...r });
      }

      res.status(201).json({
        tenant: publicTenantView(tenant, opts.domain),
        routes: opts.db.routesForTenant(tenant.id),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tenants/:id", (req: Request, res: Response) => {
    const t = opts.db.getTenantById(req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json({
      tenant: publicTenantView(t, opts.domain),
      routes: opts.db.routesForTenant(t.id),
    });
  });

  router.get("/tenants/by-slug/:slug", (req: Request, res: Response) => {
    const t = opts.db.getTenantBySlug(req.params.slug);
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json({ tenant: publicTenantView(t, opts.domain) });
  });

  router.get("/tenants/:id/metrics", (req: Request, res: Response) => {
    const t = opts.db.getTenantById(req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json(opts.db.tenantMetrics(t.id));
  });

  router.get("/tenants/:id/events", (req: Request, res: Response) => {
    const t = opts.db.getTenantById(req.params.id);
    if (!t) return res.status(404).json({ error: "not_found" });
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
    res.json({ events: opts.db.recentEvents(t.id, limit) });
  });

  router.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[control-plane error]", msg);
      res.status(400).json({ error: "bad_request", reason: msg });
    },
  );

  return router;
}

function validateRouteInput(r: CreateTenantBody["routes"][number], i: number): {
  method: string;
  path: string;
  priceUsd: string;
  description: string | null;
  backendUrl: string;
} {
  const method = String(r?.method ?? "").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`route[${i}]: invalid method "${r?.method}"`);
  }
  const path = String(r?.path ?? "");
  if (!PATH_RE.test(path)) {
    throw new Error(`route[${i}]: invalid path "${path}"`);
  }
  const priceUsd = String(r?.priceUsd ?? "");
  if (!PRICE_RE.test(priceUsd)) {
    throw new Error(`route[${i}]: invalid priceUsd "${priceUsd}"`);
  }
  let backendUrl: URL;
  try {
    backendUrl = new URL(String(r?.backendUrl ?? ""));
  } catch {
    throw new Error(`route[${i}]: invalid backendUrl`);
  }
  if (backendUrl.protocol !== "https:" && backendUrl.protocol !== "http:") {
    throw new Error(`route[${i}]: backendUrl must be http(s)`);
  }
  if (
    backendUrl.protocol === "http:" &&
    backendUrl.hostname !== "localhost" &&
    backendUrl.hostname !== "127.0.0.1"
  ) {
    throw new Error(`route[${i}]: plain http only allowed for localhost`);
  }
  return {
    method,
    path,
    priceUsd,
    description: r.description ? String(r.description).slice(0, 500) : null,
    backendUrl: backendUrl.toString().replace(/\/+$/, ""),
  };
}

function chooseSlug(
  db: SaasDb,
  preferred: string | undefined,
  walletAddress: string,
): string {
  if (preferred) {
    validateSlug(preferred);
    if (db.getTenantBySlug(preferred)) {
      throw new Error(`slug "${preferred}" already taken`);
    }
    return preferred;
  }
  for (let i = 0; i < 20; i++) {
    const slug = deriveSlug(walletAddress);
    if (!db.getTenantBySlug(slug)) return slug;
  }
  throw new Error("could not allocate slug after 20 attempts");
}

function publicTenantView(t: Tenant, domain: string) {
  return {
    id: t.id,
    walletAddress: t.walletAddress,
    slug: t.slug,
    proxyUrl: `https://${t.slug}.${domain}`,
    network: t.network,
    status: t.status,
    feeBps: t.feeBps,
    createdAt: t.createdAt,
  };
}
