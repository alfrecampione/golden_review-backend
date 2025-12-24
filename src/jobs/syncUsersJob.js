import cron from 'node-cron';
import prisma, { createOrUpdateMicrosoftUser } from '../prisma.js';
import { createGraphClient, assertGraphEnv } from '../controllers/graphController.js';

async function fetchAssignmentsWithRoles(graph, appId) {
    const sp = await graph.api(`/servicePrincipals(appId='${appId}')`).get();
    const servicePrincipalId = sp.id;

    const roles = (sp.appRoles || [])
        .filter(role => role?.isEnabled)
        .map(role => ({
            id: role.id,
            value: role.value,
            displayName: role.displayName
        }));

    let url = `/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo?$top=999`;
    const assignments = [];

    while (url) {
        const page = await graph.api(url).get();
        assignments.push(...(page.value || []));
        url = page['@odata.nextLink']
            ? page['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '')
            : null;
    }

    return { roles, assignments };
}

async function fetchUserProfile(graph, principalId) {
    const user = await graph
        .api(`/users/${principalId}`)
        .select('id,mail,userPrincipalName,displayName,givenName,surname,jobTitle,department')
        .get();

    const email = user.mail || user.userPrincipalName || null;
    return {
        id: user.id,
        mail: email,
        displayName: user.displayName,
        givenName: user.givenName,
        surname: user.surname,
        jobTitle: user.jobTitle,
        department: user.department
    };
}

async function syncGoldenAuditUsersOnce() {
    let config;
    try {
        config = assertGraphEnv();
    } catch (err) {
        console.warn(`⚠️  Skipping GoldenAudit sync: ${err.message}`);
        return;
    }

    const graph = createGraphClient(config);
    const { roles, assignments } = await fetchAssignmentsWithRoles(graph, config.clientId);

    const roleById = new Map(roles.map(r => [r.id, r.value]));
    const usersById = new Map();

    for (const assignment of assignments) {
        if (assignment.principalType !== 'User') continue;

        const roleValue = roleById.get(assignment.appRoleId);
        const existing = usersById.get(assignment.principalId) || { roles: new Set() };
        if (roleValue) {
            existing.roles.add(roleValue);
        }
        usersById.set(assignment.principalId, existing);
    }

    const syncedMicrosoftIds = new Set();

    for (const [principalId, data] of usersById.entries()) {
        try {
            const profile = await fetchUserProfile(graph, principalId);
            if (!profile.mail) {
                console.warn(`⚠️  Skipping user ${principalId}: missing mail/userPrincipalName`);
                continue;
            }

            const rolesArray = Array.from(data.roles);
            await createOrUpdateMicrosoftUser({ ...profile, roles: rolesArray });
            syncedMicrosoftIds.add(profile.id);
        } catch (error) {
            console.error(`Error syncing user ${principalId}:`, error.message);
        }
    }

    // Delete users that exist in Prisma but not in Microsoft
    const prismaUsers = await prisma.user.findMany({
        where: {
            microsoftId: {
                not: null
            }
        },
        select: {
            id: true,
            microsoftId: true
        }
    });

    const usersToDelete = prismaUsers.filter(u => !syncedMicrosoftIds.has(u.microsoftId));

    if (usersToDelete.length > 0) {
        const deleteCount = await prisma.user.deleteMany({
            where: {
                id: {
                    in: usersToDelete.map(u => u.id)
                }
            }
        });
        console.log(`🗑️  Deleted ${deleteCount.count} users not found in Microsoft`);
    }

    console.log(`✅ GoldenAudit users sync completed (${usersById.size} users synced, ${usersToDelete.length} users deleted)`);
}

let jobStarted = false;

export function startUserSyncJob() {
    if (jobStarted) return;

    // Run at minute 0 of hours 0, 6, 12, 18 UTC (4 veces al día)
    cron.schedule('0 0,6,12,18 * * *', () => {
        syncGoldenAuditUsersOnce().catch(err => console.error('Sync job failed:', err));
    });

    // Kick off one run on startup for freshness
    syncGoldenAuditUsersOnce().catch(err => console.error('Initial sync failed:', err));

    jobStarted = true;
    console.log('🕒 GoldenAudit user sync job scheduled (every 6 hours)');
}

export { syncGoldenAuditUsersOnce };
