
import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";
import type Redis from "ioredis";
import { z } from "zod";
import { authenticate, requireWorkspaceRole } from "../auth/routes.js";
import type { AuthRepository } from "../auth/types.js";
import { createClickEvent } from "../clicks/event.js";
import type { ClickEventPayload } from "../clicks/types.js";
import {
  AliasGenerationError,
  InvalidLinkInputError,
  LinkService,
} from "./service.js";
import {
  DuplicateAliasError,
  type LinkRecord,
  type LinkRepository,
} from "./types.js";
import {
  InvalidDestinationUrlError,
  validateDestinationUrl,
} from "./validation.js";

interface LinkRouteOptions {
  repository: LinkRepository;
  authRepository: AuthRepository;
  publicBaseUrl: string;
  redis?: Redis;
  generateAlias?: () => string;
  onClickAccepted?: (event: ClickEventPayload) => void | Promise<void>;
}

const workspaceParamsSchema = z.object({ workspaceId: z.string().min(1) });
const linkParamsSchema = workspaceParamsSchema.extend({
  linkId: z.string().min(1),
});
const aliasParamsSchema = z.object({
  alias: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
});
const nullableDateSchema = z.string().datetime({ offset: true }).nullable();
const createSchema = z.object({
  destinationUrl: z.string().min(1).max(2048),
  alias: z.string().min(3).max(64).optional(),
  campaignId: z.string().min(1).nullable().optional(),
  expiresAt: nullableDateSchema.optional(),
  maxClicks: z.number().int().positive().nullable().optional(),
  password: z.string().min(8).max(128).optional(),
});
const updateSchema = z.object({
  destinationUrl: z.string().min(1).max(2048).optional(),
  campaignId: z.string().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  expiresAt: nullableDateSchema.optional(),
  maxClicks: z.number().int().positive().nullable().optional(),
  password: z.string().min(8).max(128).nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0);
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

function publicLink(link: LinkRecord, publicBaseUrl: string) {
  return {
    id: link.id,
    workspaceId: link.workspaceId,
    campaignId: link.campaignId,
    alias: link.alias,
    shortUrl: `${publicBaseUrl.replace(/\/+$/, "")}/${link.alias}`,
    destinationUrl: link.destinationUrl,
    status: link.status,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    maxClicks: link.maxClicks,
    clickCount: link.clickCount,
    passwordProtected: link.passwordHash !== null,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

function errorResponse(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
) {
  return reply.code(statusCode).send({ error, message });
}

function redirectIsUnavailable(link: LinkRecord, now: Date): boolean {
  return (
    link.status !== "ACTIVE" ||
    (link.expiresAt !== null && link.expiresAt <= now) ||
    (link.maxClicks !== null && link.clickCount >= link.maxClicks)
  );
}

export function registerLinkRoutes(
  app: FastifyInstance,
  options: LinkRouteOptions,
): void {
  const service = new LinkService({
    repository: options.repository,
    ...(options.generateAlias ? { generateAlias: options.generateAlias } : {}),
  });

  app.register(async (linksApp) => {
    await linksApp.register(rateLimit, {
      global: false,
      max: 30,
      timeWindow: "1 minute",
      ...(options.redis ? { redis: options.redis } : {}),
    });

    const workspaceAccess = [
      authenticate,
      requireWorkspaceRole(options.authRepository),
    ];

    linksApp.post(
      "/workspaces/:workspaceId/links",
      {
        preHandler: workspaceAccess,
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const params = parse(workspaceParamsSchema, request.params);
        const body = parse(createSchema, request.body);
        if (!params || !body) {
          return errorResponse(reply, 400, "Bad Request", "Request validation failed");
        }

        try {
          const link = await service.createLink({
            workspaceId: params.workspaceId,
            createdById: request.user.sub,
            campaignId: body.campaignId ?? null,
            ...(body.alias !== undefined ? { alias: body.alias } : {}),
            destinationUrl: body.destinationUrl,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            maxClicks: body.maxClicks ?? null,
            ...(body.password !== undefined ? { password: body.password } : {}),
          });
          return reply.code(201).send(publicLink(link, options.publicBaseUrl));
        } catch (error) {
          if (error instanceof InvalidDestinationUrlError) {
            return errorResponse(reply, 400, "Bad Request", error.message);
          }
          if (error instanceof InvalidLinkInputError) {
            return errorResponse(reply, 400, "Bad Request", error.message);
          }
          if (error instanceof DuplicateAliasError) {
            return errorResponse(reply, 409, "Conflict", error.message);
          }
          if (error instanceof AliasGenerationError) {
            return errorResponse(reply, 503, "Service Unavailable", "Could not allocate a short link");
          }
          throw error;
        }
      },
    );

    linksApp.get(
      "/workspaces/:workspaceId/links",
      { preHandler: workspaceAccess },
      async (request, reply) => {
        const params = parse(workspaceParamsSchema, request.params);
        const query = parse(listQuerySchema, request.query);
        if (!params || !query) {
          return errorResponse(reply, 400, "Bad Request", "Request validation failed");
        }
        const links = await options.repository.listLinks(
          params.workspaceId,
          query.limit ?? 50,
        );
        return links.map((link) => publicLink(link, options.publicBaseUrl));
      },
    );

    linksApp.get(
      "/workspaces/:workspaceId/links/:linkId",
      { preHandler: workspaceAccess },
      async (request, reply) => {
        const params = parse(linkParamsSchema, request.params);
        if (!params) {
          return errorResponse(reply, 400, "Bad Request", "Request validation failed");
        }
        const link = await options.repository.findLink(
          params.workspaceId,
          params.linkId,
        );
        if (!link) {
          return errorResponse(reply, 404, "Not Found", "Link not found");
        }
        return publicLink(link, options.publicBaseUrl);
      },
    );

    linksApp.patch(
      "/workspaces/:workspaceId/links/:linkId",
      { preHandler: workspaceAccess },
      async (request, reply) => {
        const params = parse(linkParamsSchema, request.params);
        const body = parse(updateSchema, request.body);
        if (!params || !body) {
          return errorResponse(reply, 400, "Bad Request", "Request validation failed");
        }
        try {
          const link = await service.updateLink(
            params.workspaceId,
            params.linkId,
            {
              ...(body.destinationUrl !== undefined
                ? { destinationUrl: body.destinationUrl }
                : {}),
              ...(body.campaignId !== undefined
                ? { campaignId: body.campaignId }
                : {}),
              ...(body.status !== undefined ? { status: body.status } : {}),
              ...(body.expiresAt !== undefined
                ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null }
                : {}),
              ...(body.maxClicks !== undefined
                ? { maxClicks: body.maxClicks }
                : {}),
              ...(body.password !== undefined ? { password: body.password } : {}),
            },
          );
          if (!link) {
            return errorResponse(reply, 404, "Not Found", "Link not found");
          }
          return publicLink(link, options.publicBaseUrl);
        } catch (error) {
          if (error instanceof InvalidDestinationUrlError ||
              error instanceof InvalidLinkInputError) {
            return errorResponse(reply, 400, "Bad Request", error.message);
          }
          throw error;
        }
      },
    );

    linksApp.post(
      "/workspaces/:workspaceId/links/:linkId/disable",
      { preHandler: workspaceAccess },
      async (request, reply) => {
        const params = parse(linkParamsSchema, request.params);
        if (!params) {
          return errorResponse(reply, 400, "Bad Request", "Request validation failed");
        }
        const link = await options.repository.disableLink(
          params.workspaceId,
          params.linkId,
        );
        if (!link) {
          return errorResponse(reply, 404, "Not Found", "Link not found");
        }
        return publicLink(link, options.publicBaseUrl);
      },
    );

    linksApp.get("/:alias", async (request, reply) => {
      const params = parse(aliasParamsSchema, request.params);
      if (!params) {
        return errorResponse(reply, 404, "Not Found", "Link not found");
      }

      const existing = await options.repository.findByAlias(params.alias);
      if (!existing) {
        return errorResponse(reply, 404, "Not Found", "Link not found");
      }

      const now = new Date();
      if (redirectIsUnavailable(existing, now)) {
        return errorResponse(reply, 410, "Gone", "This link is no longer available");
      }
      let destinationUrl: string;
      try {
        destinationUrl = validateDestinationUrl(existing.destinationUrl);
      } catch (error) {
        request.log.warn(
          { err: error, linkId: existing.id },
          "Stored destination failed redirect validation",
        );
        return errorResponse(reply, 410, "Gone", "This link is no longer available");
      }
      if (existing.passwordHash !== null) {
        const providedPassword = request.headers["x-link-password"];
        if (typeof providedPassword !== "string") {
          return errorResponse(reply, 401, "Unauthorized", "Link password required");
        }
        if (
          providedPassword.length < 8 ||
          providedPassword.length > 128 ||
          !(await service.verifyPassword(providedPassword, existing.passwordHash))
        ) {
          return errorResponse(reply, 403, "Forbidden", "Invalid link password");
        }
      }

      const accepted = await options.repository.claimRedirect(
        existing.alias,
        existing.passwordHash,
        now,
      );
      if (!accepted) {
        const current = await options.repository.findByAlias(existing.alias);
        if (!current) {
          return errorResponse(reply, 404, "Not Found", "Link not found");
        }
        return errorResponse(
          reply,
          410,
          "Gone",
          "This link is no longer available",
        );
      }

      if (options.onClickAccepted) {
        try {
          await options.onClickAccepted(createClickEvent({
            id: randomUUID(),
            linkId: accepted.id,
            workspaceId: accepted.workspaceId,
            alias: accepted.alias,
            clickedAt: now,
            referrer: request.headers.referer,
            userAgent: request.headers["user-agent"],
          }));
        } catch (error) {
          request.log.warn(
            { err: error, linkId: accepted.id },
            "Accepted click could not be enqueued; its analytics event may be lost",
          );
        }
      }
      return reply.redirect(destinationUrl, 302);
    });
  });
}