const TEST_ACCESS_SECRET = 'synthetic-test-only-access-secret-not-for-deployment';
const AUTHORIZATION = 'Basic ' + Buffer.from('access:' + TEST_ACCESS_SECRET).toString('base64');
process.env.DEPLOYMENT_ACCESS_SECRET = TEST_ACCESS_SECRET;
module.exports = { TEST_ACCESS_SECRET, AUTHORIZATION };
