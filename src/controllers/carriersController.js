import prisma, { getMSAPhotoPath } from '../prisma.js';
import { Prisma } from '@prisma/client';

class CarriersController {
    static async getAvailableCarriers(request, reply) {
        try {
            const userId = request.query.userId;

            if (!userId) {
                request.log.warn('[getAvailableCarriers] Missing userId in query');
                return reply.code(400).send({ success: false, error: 'userId is required' });
            }

            const carriersRaw = await prisma.$queryRaw`
                SELECT entity_id AS id, display_name AS name
                FROM qq.contacts
                WHERE type_display = 'R' AND status = 'A'
                ORDER BY display_name ASC
            `;

            let carriers = carriersRaw.map(c => ({ ...c, id: String(c.id) }));

            // Filter out carriers already assigned to other users; keep unassigned and same user's carriers
            const assignedCarriers = await prisma.userCarrier.findMany({
                where: {
                    userId: {
                        not: userId // Exclude current user's carriers
                    }
                },
                select: {
                    carrierId: true
                }
            });

            const assignedCarrierIds = new Set(assignedCarriers.map(ac => String(ac.carrierId)));
            carriers = carriers.filter(c => !assignedCarrierIds.has(c.id));

            return { success: true, carriers };
        } catch (error) {
            request.log.error({ err: error }, 'Error fetching available carriers');
            return reply.code(500).send({ success: false, error: 'Internal server error' });
        }
    }

    static async getAvailableHeadCarriers(request, reply) {
        try {
            const userId = request.query.userId;

            if (!userId) {
                request.log.warn('[getAvailableHeadCarriers] Missing userId in query');
                return reply.code(400).send({ success: false, error: 'userId is required' });
            }

            const headCarriersRaw = await prisma.$queryRaw`
                SELECT head_carrier_id, "name", contact_id as carries_id
                FROM intranet.head_carriers hc
            `;

            // Map head carriers to { id, name, carriersId: string[] }
            const headCarriersMap = new Map();
            for (const row of headCarriersRaw) {
                const headCarrierId = String(row.head_carrier_id);
                if (!headCarriersMap.has(headCarrierId)) {
                    headCarriersMap.set(headCarrierId, {
                        id: headCarrierId,
                        name: row.name,
                        carriersId: []
                    });
                }
                const ids = String(row.carries_id)
                    .split(',')
                    .map(id => id.trim())
                    .filter(Boolean);
                headCarriersMap.get(headCarrierId).carriersId.push(...ids);
            }
            // Determine which carriers are already assigned to other users (not the current one)
            const assignedCarriers = await prisma.userCarrier.findMany({
                where: {
                    userId: {
                        not: userId
                    }
                },
                select: {
                    carrierId: true
                }
            });

            const assignedCarrierIds = new Set(assignedCarriers.map(ac => String(ac.carrierId)));

            // Include head carriers only if they retain at least one available carrier
            const headCarriers = Array.from(headCarriersMap.values())
                .map(hc => ({
                    ...hc,
                    carriersId: (hc.carriersId || []).filter(cid => !assignedCarrierIds.has(String(cid)))
                }))
                .filter(hc => (hc.carriersId && hc.carriersId.length > 0));

            return { success: true, headCarriers };
        } catch (error) {
            request.log.error({ err: error }, 'Error fetching available head carriers');
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
                    position: true,
                    microsoftId: true
                }
            });

            const userIds = usersWithRoleUser.map(u => u.id);

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

            const byUser = new Map();
            for (const link of links) {
                if (!byUser.has(link.userId)) {
                    byUser.set(link.userId, new Set());
                }
                byUser.get(link.userId).add(link.carrierId);
            }

            const allCarrierIds = Array.from(new Set(links.map(l => l.carrierId))); // unique ids

            // Fetch carrier display names from external table
            const carrierRows = allCarrierIds.length
                ? await prisma.$queryRaw`
                  SELECT entity_id AS id, display_name AS name
                  FROM qq.contacts
                  WHERE entity_id IN (${Prisma.join(allCarrierIds.map(Number))})
                `
                : [];

            const carrierNameById = new Map(
                carrierRows.map(row => [String(row.id), row.name])
            );

            const usersMapped = await Promise.all(
                usersWithRoleUser.map(async (user) => {
                    const displayName = user.fullName
                        || [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
                        || user.email;

                    const carriers = Array.from(byUser.get(user.id) || new Set()).map(id => ({
                        carrierId: id,
                        carrierName: carrierNameById.get(String(id)) || null
                    }));

                    const photoPath = await getMSAPhotoPath(user.microsoftId);

                    return {
                        userId: user.id,
                        name: displayName,
                        email: user.email,
                        department: user.department || null,
                        position: user.position || null,
                        carriers,
                        photoPath: photoPath || null
                    };
                })
            );

            const filtered = search
                ? usersMapped.filter(user => {
                    const carrierNames = user.carriers.map(c => c.carrierName || c.carrierId).join(' ');
                    return [user.name, user.email, user.department || '', user.position || '', carrierNames]
                        .some(value => value.toLowerCase().includes(search));
                })
                : usersMapped;

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

            const total = sorted.length;
            const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
            const start = (page - 1) * limit;
            const data = sorted.slice(start, start + limit);

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

            const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
            if (!user) {
                request.log.warn({ userId }, '[updateUserCarriers] User not found');
                return reply.code(404).send({ success: false, error: 'User not found' });
            }

            const existing = await prisma.userCarrier.findMany({
                where: { userId },
                select: { carrierId: true }
            });

            // Ensure all existing carrierIds are strings for comparison
            const existingSet = new Set(existing.map(e => String(e.carrierId)));
            const incomingSet = new Set(uniqueCarrierIds);

            const toDelete = [...existingSet].filter(id => !incomingSet.has(id));
            const toInsert = [...incomingSet].filter(id => !existingSet.has(id));

            await prisma.$transaction(async tx => {
                if (toDelete.length) {
                    await tx.userCarrier.deleteMany({
                        where: { userId, carrierId: { in: toDelete } }
                    });
                }

                if (toInsert.length) {
                    await tx.userCarrier.createMany({
                        data: toInsert.map(carrierId => ({ userId, carrierId })),
                        skipDuplicates: true
                    });
                }
            });

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
