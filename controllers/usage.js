// GET /api/usage - every meter for the signed-in user, plus credits.
const usage = require('../lib/usage');
const credits = require('../lib/credits');
const { serverCopy } = require('../lib/copy');

async function getUsage(req, res) {
  try {
    const ent = req.entitlement;
    const [meters, balance] = await Promise.all([usage.snapshot(ent), credits.balance(ent.userId)]);
    return res.json({
      plan: ent.plan,
      planSource: ent.planSource,
      trialing: ent.trialing,
      pastDue: ent.pastDue,
      periods: { daily: ent.periods.daily, monthly: ent.periods.monthly },
      limits: ent.limits,
      meters,
      credits: { total: balance.total, purchased: balance.purchased, granted: balance.granted, grants: balance.grants },
    });
  } catch (err) {
    console.error('[usage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { getUsage };
