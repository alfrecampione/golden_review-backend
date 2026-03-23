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

function normalizeInsuranceCompanyName(name) {
    if (!name || typeof name !== 'string') {
        return null;
    }
    return name.split('PO Box')[0].trim();
}

function normalizeWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function collectDriverNames(drivers) {
    if (!Array.isArray(drivers)) {
        return [];
    }

    const names = new Set();

    drivers.forEach(driver => {
        if (!driver || typeof driver !== 'object') {
            return;
        }

        const firstName = typeof driver.first_name === 'string' ? normalizeWhitespace(driver.first_name) : '';
        const lastName = typeof driver.last_name === 'string' ? normalizeWhitespace(driver.last_name) : '';
        if (firstName && lastName) {
            names.add(`${firstName} ${lastName}`);
        }

        Object.entries(driver).forEach(([key, value]) => {
            if (typeof value !== 'string') {
                return;
            }

            const lowerKey = key.toLowerCase();
            const isNameField = lowerKey.includes('name') && !lowerKey.includes('address');
            if (!isNameField) {
                return;
            }

            const normalizedValue = normalizeWhitespace(value);
            if (normalizedValue.length >= 3) {
                names.add(normalizedValue);
            }
        });
    });

    return Array.from(names);
}

function getRawInsuredText(policy) {
    if (!policy || typeof policy !== 'object') {
        return null;
    }

    const directCandidates = [
        policy.name_insured,
        policy.named_insured,
        policy.insured_name,
        policy.name_and_address,
    ];

    const directMatch = directCandidates.find(candidate => typeof candidate === 'string' && candidate.trim());
    if (directMatch) {
        return directMatch;
    }

    const dynamicKeyMatch = Object.entries(policy).find(([key, value]) => {
        if (typeof value !== 'string') {
            return false;
        }

        const normalizedKey = key.toLowerCase().replace(/[_\s-]+/g, '');
        return normalizedKey === 'nameinsured' || normalizedKey === 'namedinsured';
    });

    return dynamicKeyMatch ? dynamicKeyMatch[1] : null;
}

function splitInsuredNameAndAddress(rawInsuredText, drivers) {
    if (!rawInsuredText || typeof rawInsuredText !== 'string') {
        return {
            nameInsured: null,
            insuredAddress: null,
        };
    }

    const cleanedInsuredText = normalizeWhitespace(
        rawInsuredText
            .replace(/^(named?\s+insured)\s*[:\-]?\s*/i, '')
    );

    if (!cleanedInsuredText) {
        return {
            nameInsured: null,
            insuredAddress: null,
        };
    }

    const driverNames = collectDriverNames(drivers)
        .sort((a, b) => b.length - a.length);

    const lowerInsuredText = cleanedInsuredText.toLowerCase();
    const matchedName = driverNames.find(driverName => lowerInsuredText.startsWith(driverName.toLowerCase()));

    if (!matchedName) {
        return {
            nameInsured: cleanedInsuredText,
            insuredAddress: null,
        };
    }

    const nameInsured = cleanedInsuredText.slice(0, matchedName.length).trim().replace(/[,-]+$/, '').trim();
    const addressPart = cleanedInsuredText
        .slice(matchedName.length)
        .replace(/^[,\-:\s]+/, '')
        .trim();

    return {
        nameInsured: nameInsured || null,
        insuredAddress: addressPart || null,
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
        const insuranceCompany = normalizeInsuranceCompanyName(policy.insurance_company);
        const rawInsuredText = getRawInsuredText(policy);
        const { nameInsured, insuredAddress } = splitInsuredNameAndAddress(rawInsuredText, drivers);
        return {
            policy_number: policy.policy_number || null,
            insurance_company: insuranceCompany,
            name_insured: nameInsured,
            insured_address: insuredAddress,
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