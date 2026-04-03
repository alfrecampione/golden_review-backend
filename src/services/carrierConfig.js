import prisma from '../prisma.js';

const DOCUMENT_TYPES = Object.freeze({
    DECLARATION_PAGE: 'declaration_page',
    APPLICATION: 'application',
    ID_CARD: 'id_card',
    DISCLAIMED_INSURANCE_EN: 'disclaimed_insurance_en',
    DISCLAIMED_INSURANCE_ES: 'disclaimed_insurance_es',
    HOUSEHOLD_MEMBER_DISCLOSURE_EN: 'household_member_disclosure_en',
    HOUSEHOLD_MEMBER_DISCLOSURE_ES: 'household_member_disclosure_es',
    COMP_COLLISION_EXCLUDED_EN: 'comp_collision_excluded_en',
    BI_REJECTION_EN: 'bi_rejection_en',
    BI_REJECTION_ES: 'bi_rejection_es',
    UM_REJECTION_ES: 'um_rejection_es',
    UM_REJECTION_EN: 'um_rejection_en',
});

const DOCUMENT_TYPE_DESCRIPTIONS = Object.freeze({
    [DOCUMENT_TYPES.DECLARATION_PAGE]: 'Policy summary / dec page showing coverages and premiums',
    [DOCUMENT_TYPES.APPLICATION]: "Carrier's application form for insurance with detailed policy data, drivers, vehicles, coverages, discounts, underwriting",
    [DOCUMENT_TYPES.ID_CARD]: 'Insurance ID card',
    [DOCUMENT_TYPES.DISCLAIMED_INSURANCE_EN]: 'Disclaimed Insurance disclosure (English)',
    [DOCUMENT_TYPES.DISCLAIMED_INSURANCE_ES]: 'Disclaimed Insurance disclosure (Spanish / Español)',
    [DOCUMENT_TYPES.HOUSEHOLD_MEMBER_DISCLOSURE_EN]: 'Household Member Disclosure (English)',
    [DOCUMENT_TYPES.HOUSEHOLD_MEMBER_DISCLOSURE_ES]: 'Household Member Disclosure (Spanish / Español)',
    [DOCUMENT_TYPES.COMP_COLLISION_EXCLUDED_EN]: 'Comprehensive and Collision Coverage Excluded Disclosure (English)',
    [DOCUMENT_TYPES.BI_REJECTION_EN]: 'Bodily Injury Liability Rejection Disclosure (English)',
    [DOCUMENT_TYPES.BI_REJECTION_ES]: 'Responsabilidad por Daños Corporales - Declaración de Rechazo (Spanish / Español)',
    [DOCUMENT_TYPES.UM_REJECTION_ES]: 'Cobertura de Motorista No Asegurado (UM) - Declaración de Rechazo (Spanish / Español)',
    [DOCUMENT_TYPES.UM_REJECTION_EN]: 'Uninsured Motorist (UM) Rejection Disclosure (English)',
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

const MIN_CONFIDENCE = 0.90;

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
    DOCUMENT_TYPE_DESCRIPTIONS,
    MIN_CONFIDENCE,
    getSchema,
    getInstructions,
    resolveCarrierName,
};
