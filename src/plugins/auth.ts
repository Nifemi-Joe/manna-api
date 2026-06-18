/**
 * src/plugins/auth.ts
 * Fastify plugin that:
 *  - Reads the session cookie on every request
 *  - Decorates request with `user`, `session`, `requireAuth()`, `requirePermission()`
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getSession, getUserById, getUserPermissions, formatUser, SESSION_COOKIE } from '../services/auth.js';

declare module 'fastify' {
    interface FastifyRequest {
        sessionId: string | null;
        userId: string | null;
        userPortal: string | null;
        requireAuth(): Promise<ReturnType<typeof formatUser>>;
        requirePermission(perm: string): Promise<ReturnType<typeof formatUser>>;
    }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.decorateRequest('sessionId', null);
    fastify.decorateRequest('userId', null);
    fastify.decorateRequest('userPortal', null);

    fastify.addHook('preHandler', async (req: FastifyRequest) => {
        const sid = req.cookies?.[SESSION_COOKIE];
        if (!sid) return;

        const session = getSession(sid);
        if (!session) return;

        req.sessionId = sid;
        req.userId = session.userId;
        req.userPortal = session.portal;
    });

    fastify.decorateRequest('requireAuth', async function (this: FastifyRequest) {
        if (!this.userId) {
            throw { statusCode: 401, message: 'Authentication required' };
        }
        const user = getUserById(this.userId);
        if (!user || user.status !== 'active') {
            throw { statusCode: 401, message: 'Session invalid or account suspended' };
        }
        return formatUser(user);
    });

    fastify.decorateRequest('requirePermission', async function (this: FastifyRequest, perm: string) {
        const user = await this.requireAuth();
        const perms = getUserPermissions(this.userId!);
        if (!perms.includes(perm)) {
            throw { statusCode: 403, message: `Permission required: ${perm}` };
        }
        return user;
    });
};

export default fp(authPlugin, { name: 'auth' });