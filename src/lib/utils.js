const MONTH_INDEX = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
};

function normalizeUsDate(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return null;
    }

    const numericMatch = trimmedValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (numericMatch) {
        const [, month, day, year] = numericMatch;
        return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
    }

    const textMatch = trimmedValue.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
    if (!textMatch) {
        return trimmedValue;
    }

    const [, monthName, day, year] = textMatch;
    const month = MONTH_INDEX[monthName.slice(0, 3).toLowerCase()];

    if (!month) {
        return trimmedValue;
    }

    return `${month}/${day.padStart(2, '0')}/${year}`;
}

function normalizeUsDateTime(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return null;
    }

    const dateTimeMatch = trimmedValue.match(/^([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s+at\s+(\d{1,2}:\d{2}\s*[APMapm]{2})(?:\s+([A-Za-z]{2,4}))?$/);
    if (!dateTimeMatch) {
        return trimmedValue;
    }

    const [, datePart, timePart, timezone] = dateTimeMatch;
    const normalizedDate = normalizeUsDate(datePart);
    const normalizedTime = timePart.replace(/\s+/g, '').toUpperCase();

    return timezone
        ? `${normalizedDate} ${normalizedTime} ${timezone.toUpperCase()}`
        : `${normalizedDate} ${normalizedTime}`;
}

function normalizePolicyPeriod(policyPeriod) {
    if (!policyPeriod || typeof policyPeriod !== 'string') {
        return {
            effectiveDate: null,
            expirationDate: null,
        };
    }

    const separatePeriod = policyPeriod.split(' - ');
    const effectiveDate = normalizeUsDate(separatePeriod[0]);
    const expirationDate = normalizeUsDate(separatePeriod[1]);

    return {
        effectiveDate,
        expirationDate,
    };
}

export function mapLambdaResultToPolicyJson(lambdaResult) {
    const policy = lambdaResult?.policy || {};
    const drivers = lambdaResult?.drivers || [];
    const vehicles = lambdaResult?.outline || [];
    const discounts = lambdaResult?.discounts || [];
    const underwriting = lambdaResult?.underwriting || {};

    function mapPolicy(policy) {
        const policyPeriod = policy.policy_period || null;
        const { effectiveDate, expirationDate } = normalizePolicyPeriod(policyPeriod);
        return {
            policy_number: policy.policy_number || null,
            insurance_company: policy.insurance_company || null,
            effective_date: effectiveDate,
            expiration_date: expirationDate,
            effective_date_and_time: normalizeUsDateTime(policy.effective_date_and_time),
            total_policy_premium: policy.total_policy_premium || null
        }
    }
    function mapDriver(driver) {
        if (!Array.isArray(driver)) {
            return [];
        }

        return driver.map(item => ({
            ...item,
            date_of_birth: normalizeUsDate(item?.date_of_birth),
        }));
    }
    function mapVehicle(vehicle) {
        return vehicle;
    }
    function mapDiscount(discount) {
        return discount;
    }
    function mapUnderwriting(underwriting) {
        const prior_insurance = underwriting.prior_insurance || {};
        if (prior_insurance === 'Yes') {
            return underwriting;
        }
        return {
            prior_insurance: 'No'
        }
    }

    return {
        policy: mapPolicy(policy),
        drivers: mapDriver(drivers),
        coverages: mapVehicle(vehicles),
        discounts: mapDiscount(discounts),
        underwriting: mapUnderwriting(underwriting)
    }
}