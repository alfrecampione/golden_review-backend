import prisma from '../prisma.js';
import { Prisma } from '@prisma/client';

class CarriersController {
    static async getAvailableCarriers(request, reply) {
        try {
            const carriersRaw = await prisma.$queryRaw`
                SELECT entity_id AS id, display_name AS name
                FROM qq.contacts
                WHERE type_display = 'R' AND status = 'A'
                ORDER BY display_name ASC
            `;
            // Convertir id a string
            const carriers = carriersRaw.map(c => ({ ...c, id: String(c.id) }));
            return { success: true, carriers };
        } catch (error) {
            request.log.error({ err: error }, 'Error fetching available carriers');
            return reply.code(500).send({ success: false, error: 'Internal server error' });
        }
    }

    static async getAllUserCarriers(request, reply) {
        try {
            const page = Math.max(parseInt(request.query.page, 10) || 1, 1);
            const limitRaw = parseInt(request.query.limit, 10) || 25;
            const limit = Math.min(Math.max(limitRaw, 1), 200);
            const search = (request.query.search || '').trim().toLowerCase();
            const sortBy = (request.query.sortBy || 'name');
            const sortOrder = request.query.sortOrder === 'desc' ? 'desc' : 'asc';

            request.log.info({ page, limit, search, sortBy, sortOrder }, '[getAllUserCarriers] Query params');

            // Obtener todos los usuarios con rol "User"
            const usersWithRoleUser = await prisma.user.findMany({
                where: {
                    roles: {
                        has: 'User'
                    }
                },
                select: {
                    id: true,
                    email: true,
                    fullName: true,
                    firstName: true,
                    lastName: true,
                    department: true,
                    position: true
                }
            });
            request.log.info({ usersWithRoleUser }, '[getAllUserCarriers] usersWithRoleUser');

            const userIds = usersWithRoleUser.map(u => u.id);
            request.log.info({ userIds }, '[getAllUserCarriers] userIds');

            // Luego obtener los links de userCarrier solo para estos usuarios
            const links = userIds.length
                ? await prisma.userCarrier.findMany({
                    where: {
                        userId: {
                            in: userIds
                        }
                    },
                    select: { userId: true, carrierId: true }
                })
                : [];
            request.log.info({ links }, '[getAllUserCarriers] userCarrier links');

            const byUser = new Map();
            for (const link of links) {
                if (!byUser.has(link.userId)) {
                    byUser.set(link.userId, new Set());
                }
                byUser.get(link.userId).add(link.carrierId);
            }

            const allCarrierIds = Array.from(new Set(links.map(l => l.carrierId))); // unique ids
            request.log.info({ allCarrierIds }, '[getAllUserCarriers] allCarrierIds');

            // Fetch carrier display names from external table
            const carrierRows = allCarrierIds.length
                ? await prisma.$queryRaw`
                  SELECT entity_id AS id, display_name AS name
                  FROM qq.contacts
                  WHERE entity_id IN (${Prisma.join(allCarrierIds.map(Number))})
                `
                : [];
            request.log.info({ carrierRows }, '[getAllUserCarriers] carrierRows');

            const carrierNameById = new Map(
                carrierRows.map(row => [String(row.id), row.name])
            );

            // Devolver todos los usuarios, incluso los que no tienen carriers
            const usersMapped = usersWithRoleUser.map(user => {
                const displayName = user.fullName
                    || [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
                    || user.email;

                const carriers = Array.from(byUser.get(user.id) || new Set()).map(id => ({
                    carrierId: id,
                    carrierName: carrierNameById.get(String(id)) || null
                }));

                return {
                    userId: user.id,
                    name: displayName,
                    email: user.email,
                    department: user.department || null,
                    position: user.position || null,
                    carriers
                };
            });
            request.log.info({ usersMapped }, '[getAllUserCarriers] usersMapped');

            // Búsqueda server-side (incluye carriers)
            const filtered = search
                ? usersMapped.filter(user => {
                    const carrierNames = user.carriers.map(c => c.carrierName || c.carrierId).join(' ');
                    return [user.name, user.email, user.department || '', user.position || '', carrierNames]
                        .some(value => value.toLowerCase().includes(search));
                })
                : usersMapped;
            request.log.info({ filtered }, '[getAllUserCarriers] filtered');

            const carrierString = user => user.carriers.map(c => c.carrierName || c.carrierId).join(', ');

            const sorted = filtered.sort((a, b) => {
                const direction = sortOrder === 'desc' ? -1 : 1;

                const pick = (user) => {
                    switch (sortBy) {
                        case 'email':
                            return user.email || '';
                        case 'department':
                            return user.department || '';
                        case 'position':
                            return user.position || '';
                        case 'carriers':
                            return carrierString(user);
                        case 'name':
                        default:
                            return user.name || '';
                    }
                };

                const valA = pick(a).toLowerCase();
                const valB = pick(b).toLowerCase();

                if (valA < valB) return -1 * direction;
                if (valA > valB) return 1 * direction;
                return 0;
            });
            request.log.info({ sorted }, '[getAllUserCarriers] sorted');

            const total = sorted.length;
            const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
            const start = (page - 1) * limit;
            const data = sorted.slice(start, start + limit);
            request.log.info({ total, totalPages, start, data }, '[getAllUserCarriers] pagination/data');

            return {
                success: true,
                count: total,
                page,
                limit,
                totalPages,
                data
            };
        } catch (error) {
            request.log.error({ err: error, query: request.query }, '[getAllUserCarriers] Error fetching user carriers');
            return reply.code(500).send({ success: false, error: 'Internal server error', details: error?.message });
        }
    }

    static async updateUserCarriers(request, reply) {
        try {
            const { id: userId } = request.params;
            const carrierIds = request.body?.carrierIds;

            console.log({ userId, carrierIds }, '[updateUserCarriers] Input params');

            if (!userId) {
                request.log.warn('[updateUserCarriers] Missing userId');
                return reply.code(400).send({ success: false, error: 'userId is required' });
            }

            if (!Array.isArray(carrierIds)) {
                request.log.warn({ carrierIds }, '[updateUserCarriers] carrierIds is not an array');
                return reply.code(400).send({ success: false, error: 'carrierIds must be an array' });
            }

            // Convert all carrierIds to strings and filter out falsy values
            const uniqueCarrierIds = Array.from(new Set(carrierIds.filter(Boolean).map(String)));
            request.log.info({ uniqueCarrierIds }, '[updateUserCarriers] uniqueCarrierIds after filtering');

            const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
            if (!user) {
                request.log.warn({ userId }, '[updateUserCarriers] User not found');
                return reply.code(404).send({ success: false, error: 'User not found' });
            }

            const existing = await prisma.userCarrier.findMany({
                where: { userId },
                select: { carrierId: true }
            });
            request.log.info({ existing }, '[updateUserCarriers] Existing userCarrier links');

            // Ensure all existing carrierIds are strings for comparison
            const existingSet = new Set(existing.map(e => String(e.carrierId)));
            const incomingSet = new Set(uniqueCarrierIds);

            const toDelete = [...existingSet].filter(id => !incomingSet.has(id));
            const toInsert = [...incomingSet].filter(id => !existingSet.has(id));
            request.log.info({ toDelete, toInsert }, '[updateUserCarriers] toDelete/toInsert');

            await prisma.$transaction(async tx => {
                if (toDelete.length) {
                    request.log.info({ toDelete }, '[updateUserCarriers] Deleting userCarrier links');
                    await tx.userCarrier.deleteMany({
                        where: { userId, carrierId: { in: toDelete } }
                    });
                }

                if (toInsert.length) {
                    request.log.info({ toInsert }, '[updateUserCarriers] Creating userCarrier links');
                    await tx.userCarrier.createMany({
                        data: toInsert.map(carrierId => ({ userId, carrierId })),
                        skipDuplicates: true
                    });
                }
            });

            request.log.info('[updateUserCarriers] Update successful');
            return {
                success: true,
                userId,
                carrierIds: uniqueCarrierIds
            };
        } catch (error) {
            request.log.error({ err: error, body: request.body, params: request.params }, '[updateUserCarriers] Error updating user carriers');
            return reply.code(500).send({ success: false, error: 'Internal server error', details: error?.message });
        }
    }
}

export default CarriersController;
