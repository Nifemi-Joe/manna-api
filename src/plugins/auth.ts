/**
 * src/plugins/auth.ts
 * Fastify plugin that:
 *  - Reads the session cookie on every request
 *  - Decorates request with `requireAuth()`, `requirePermission()`
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getSession, getUserById, getUserPermissions, formatUser, SESSION_COOKIE } from '../services/auth.js';

type FormattedUser = Awaited<ReturnType<typeof formatUser>>;

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string | null;
    userId: string | null;
    userPortal: string | null;
    requireAuth(): Promise<FormattedUser>;
    requirePermission(perm: string): Promise<FormattedUser>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('sessionId', null);
  fastify.decorateRequest('userId', null);
  fastify.decorateRequest('userPortal', null);

  fastify.addHook('preHandler', async (req: FastifyRequest) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return;

    const session = await getSession(sid);
    if (!session) return;

    req.sessionId = sid;
    req.userId = session.userId;
    req.userPortal = session.portal;
  });

  fastify.decorateRequest('requireAuth', async function (this: FastifyRequest) {
    if (!this.userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }
    const user = await getUserById(this.userId);
    if (!user || user.status !== 'active') {
      throw { statusCode: 401, message: 'Session invalid or account suspended' };
    }
    return formatUser(user);
  });

  fastify.decorateRequest('requirePermission', async function (this: FastifyRequest, perm: string) {
    const user = await this.requireAuth();
    const perms = await getUserPermissions(this.userId!);
    if (!perms.includes(perm)) {
      throw { statusCode: 403, message: `Permission required: ${perm}` };
    }
    return user;
  });
};

export default fp(authPlugin, { name: 'auth' });