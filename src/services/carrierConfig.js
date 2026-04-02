import prisma from '../prisma.js';

const DOCUMENT_TYPES = Object.freeze({
    DECLARATION_PAGE: 'declaration_page',
    APPLICATION: 'application',
    ID_CARD: 'id_card',
    OTHER: 'other',
});

const HEAD_CARRIER_MAP = Object.freeze({
    2: 'progressive',
});

const APPLICATION_SCHEMAS = Object.freeze({
    progressive: {
        policy: {
            policy_number: 'string',
            insurance_company: 'string',
            name_insured: 'string',
            insured_address: 'string',
            effective_date: 'string',
            expiration_date: 'string',
            effective_date_and_time: 'string',
            total_policy_premium: 'string',
        },
        drivers: [
            {
                name: 'string',
                date_of_birth: 'string',
                gender: 'string',
                marital_status: 'string',
                relationship: 'string',
                driver_status: 'string',
                license_type: 'string',
                occupation: 'string',
            },
        ],
        coverages: [
            {
                vehicle: 'string',
                vin: 'string',
                garaging_zip_code: 'string',
                primary_use: 'string',
                annual_miles: 'string',
                length_of_vehicle_ownership: 'string',
                total_premium: 'string',
                coverages: [
                    {
                        coverage: 'string',
                        premium: 'string',
                        limit: 'string',
                    },
                ],
            },
        ],
        discounts: [
            {
                Policy: 'string (policy number, present only for policy-level discounts)',
                Vehicle: 'string (vehicle description, present only for vehicle-level discounts)',
                discount: 'string',
            },
        ],
        underwriting: {
            prior_insurance: 'string',
            bodily_injury_limits: 'string',
            most_recent_insurance_carrier: 'string',
        },
    },
});

const CARRIER_INSTRUCTIONS = Object.freeze({
    progressive: [
        'Progressive declaration pages / applications have structured vehicle sections',
        'Coverage tables are grouped per vehicle',
        'Drivers are listed separately with details',
        'Discounts can be policy-level or vehicle-level',
        'Extract ALL vehicles and ALL nested coverages per vehicle',
        'Extract ALL discounts, distinguishing between policy-level and vehicle-level',
        'Extract underwriting info including prior insurance and bodily injury limits',
        'Keep raw values exactly as they appear in the document (do NOT convert currency, dates, etc.)',
    ],
});

const MIN_CONFIDENCE = 0.7;

function getSchema(carrier) {
    return APPLICATION_SCHEMAS[carrier] ?? null;
}

function getInstructions(carrier) {
    const lines = CARRIER_INSTRUCTIONS[carrier];
    if (!lines) return '';
    return lines.map(l => `- ${l}`).join('\n');
}

async function resolveCarrierName(carrierId) {
    if (!carrierId) return null;

    const headCarrierRaw = await prisma.$queryRaw`
        SELECT head_carrier_id
        FROM intranet.head_carriers hc
        WHERE ${carrierId} = ANY(hc.contact_id)
    `;

    const resolvedId = headCarrierRaw?.[0]?.head_carrier_id ?? carrierId;
    return HEAD_CARRIER_MAP[Number(resolvedId)] ?? null;
}

export {
    DOCUMENT_TYPES,
    MIN_CONFIDENCE,
    getSchema,
    getInstructions,
    resolveCarrierName,
};
