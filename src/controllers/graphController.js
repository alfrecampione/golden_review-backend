import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';

const graphEnv = {
    tenantId: process.env.MS_TENANT_ID,
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET
};

function assertGraphEnv() {
    const missing = Object.entries(graphEnv)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missing.length) {
        const error = new Error(`Missing Azure AD configuration: ${missing.join(', ')}`);
        error.missingEnv = missing;
        throw error;
    }

    return graphEnv;
}

function createGraphClient(config = assertGraphEnv()) {
    const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
    return Client.initWithMiddleware({
        authProvider: {
            getAccessToken: async () => {
                const token = await credential.getToken('https://graph.microsoft.com/.default');
                return token.token;
            }
        }
    });
}

class GraphController {
    static async getGoldenAuditUsers(request, reply) {
        try {
            const config = assertGraphEnv();

            const graph = createGraphClient(config);
            const sp = await graph.api(`/servicePrincipals(appId='${config.clientId}')`).get();
            const servicePrincipalId = sp.id;

            const roles = (sp.appRoles || [])
                .filter(role => role?.isEnabled)
                .map(role => ({
                    id: role.id,
                    value: role.value,
                    displayName: role.displayName,
                    description: role.description
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

            const users = assignments.map(a => ({
                principalId: a.principalId,
                principalDisplayName: a.principalDisplayName,
                principalType: a.principalType,
                appRoleId: a.appRoleId,
                createdDateTime: a.createdDateTime
            }));

            return {
                success: true,
                servicePrincipalId,
                roles,
                users
            };
        } catch (error) {
            request.log.error({ err: error }, 'Error fetching Azure AD assignments');
            return reply.code(500).send({
                success: false,
                error: 'Unable to fetch GoldenAudit assignments',
                details: error.message
            });
        }
    }
}

export default GraphController;
export { createGraphClient, assertGraphEnv };
