export function mapLambdaResultToPolicyJson(lambdaResult) {
    const policy = lambdaResult?.policy || {};
    const drivers = lambdaResult?.drivers || [];
    const vehicles = lambdaResult?.outline || [];
    const discounts = lambdaResult?.discounts || [];
    const underwriting = lambdaResult?.underwriting || {};

    function mapPolicy(policy) {
        const policyPeriod = policy.policy_period || null;
        const separatePeriod = policyPeriod ? policyPeriod.split('-') : null;
        const effectiveDate = separatePeriod ? separatePeriod[0]?.trim() : null;
        const expirationDate = separatePeriod ? separatePeriod[1]?.trim() : null;
        return {
            policy_number: policy.policy_number || null,
            insurance_company: policy.insurance_company || null,
            effective_date: effectiveDate,
            expiration_date: expirationDate,
            effective_date_and_time: policy.effective_date_and_time || null,
            total_policy_premium: policy.total_policy_premium || null
        }
    }
    function mapDriver(driver) {
        return driver;
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