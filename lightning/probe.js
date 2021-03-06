const {randomBytes} = require('crypto');

const asyncAuto = require('async/auto');
const asyncDetectLimit = require('async/detectLimit');
const asyncTimeout = require('async/timeout');
const {returnResult} = require('asyncjs-util');

const pay = require('./../lightning/pay');

const defaultProbeTimeoutMs = 1000 * 10;
const genericFailType = 'forward_failure';
const {isArray} = Array;
const paymentHashByteLength = 32;
const stuckType = 'stuck_htlc';
const successType = 'success';
const tempChanFailCode = 'TemporaryChannelFailure';
const tempChanFailType = 'temporary_channel_failure';

/** Probe routes to find a successful route

  It's better to use `probeForRoute` instead of this method, but this method
  does not require the `routerrpc` build tag.

  Requires `offchain:write` permission

  {
    [limit]: <Simultaneous Attempt Limit Number>
    lnd: <Authenticated LND API Object>
    routes: [{
      fee: <Total Fee Tokens To Pay Number>
      fee_mtokens: <Total Fee Millitokens To Pay String>
      hops: [{
        channel: <Standard Format Channel Id String>
        channel_capacity: <Channel Capacity Tokens Number>
        fee: <Fee Number>
        fee_mtokens: <Fee Millitokens String>
        forward: <Forward Tokens Number>
        forward_mtokens: <Forward Millitokens String>
        [public_key]: <Public Key Hex String>
        timeout: <Timeout Block Height Number>
      }]
    }]
    [timeout]: <Probe Timeout Milliseconds Number>
  }

  @returns via cbk or Promise
  {
    generic_failures: [{
      channel: <Standard Format Channel Id String>
      public_key: <Failed Edge Public Key Hex String>
    }]
    [route]: {
      fee: <Total Fee Tokens To Pay Number>
      fee_mtokens: <Total Fee Millitokens To Pay String>
      hops: [{
        channel: <Standard Format Channel Id String>
        channel_capacity: <Channel Capacity Tokens Number>
        fee: <Fee Number>
        fee_mtokens: <Fee Millitokens String>
        forward: <Forward Tokens Number>
        forward_mtokens: <Forward Millitokens String>
        [public_key]: <Public Key Hex String>
        timeout: <Timeout Block Height Number>
      }]
    }
    stuck: [{
      channel: <Standard Format Channel Id String>
      public_key: <Public Key Hex String>
    }]
    successes: [{
      channel: <Standard Format Channel Id String>
      public_key: <Public Key Hex String>
    }]
    temporary_failures: [{
      channel: <Standard Format Channel Id String>
      public_key: <Public Key Hex String>
    }]
  }
*/
module.exports = ({limit, lnd, routes, timeout}, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!lnd) {
          return cbk([400, 'ExpectedLndForProbeAttempts']);
        }

        if (!isArray(routes)) {
          return cbk([400, 'ExpectedArrayOfRoutesToProbe']);
        }

        return cbk();
      },

      // Probe
      probe: ['validate', ({}, cbk) => {
        const attempts = [];
        const payTimeoutMs = timeout || defaultProbeTimeoutMs;
        const probeCount = limit || [lnd].length;

        return asyncDetectLimit(routes, probeCount, (route, cbk) => {
          const routeHasFailedEdge = route.hops.find(hop => {
            return attempts.find(n => {
              switch (n.type) {
              case 'failed_forward':
              case 'stuck_htlc':
              case 'temporary_channel_failure':
                if (hop.channel !== n.channel) {
                  return false;
                }

                return hop.public_key === n.public_key;

              default:
                return false;
              }
            });
          });

          // Exit early when this route has a known failed edge
          if (!!routeHasFailedEdge) {
            return cbk(null, false);
          }

          const id = randomBytes(paymentHashByteLength).toString('hex');
          const routes = [route];

          return asyncTimeout(pay, payTimeoutMs)({
            lnd,
            path: {id, routes},
          },
          err => {
            const isStuck = !!err && !isArray(err) && err.code === 'ETIMEDOUT';

            if (isStuck) {
              // All hops in a stuck route are suspect
              route.hops.forEach(hop => {
                return attempts.push({
                  channel: hop.channel,
                  public_key: hop.public_key,
                  type: stuckType,
                });
              });

              return cbk(null, false);
            }

            if (!isArray(err)) {
              return cbk([503, 'UnexpectedErrEncounteredWhenProbing', {err}]);
            }

            const [, code, msg] = err;

            if (code === 'UnknownPaymentHash') {
              // Every hop in this route was successful
              route.hops.forEach(hop => {
                return attempts.push({
                  channel: hop.channel,
                  public_key: hop.public_key,
                  type: successType,
                });
              });

              return cbk(null, true);
            }

            // On some errors, the exact channel that failed is returned
            const failedChan = !msg ? null : msg.channel;

            // Cross-reference hops to find the failed edge
            const failIndex = route.hops
              .findIndex(n => n.channel === failedChan);

            // Any edge before a failed edge is a successful edge
            if (failIndex > [failedChan].length) {
              route.hops.slice([].length, failIndex).forEach(hop => {
                return attempts.push({
                  channel: hop.channel,
                  public_key: hop.public_key,
                  type: successType,
                });
              });
            }

            if (route.hops[failIndex]) {
              const isTempChanFail = code === tempChanFailCode;

              attempts.push({
                channel: failedChan,
                public_key: route.hops[failIndex].public_key,
                type: isTempChanFail ? tempChanFailType : genericFailType,
              });
            }

            return cbk(null, false);
          });
        },
        (err, route) => {
          if (!!err) {
            return cbk(err);
          }

          // Successes are when a probe traversed an edge successfully
          const successes = attempts.filter(n => n.type === successType);

          // Temporary failures are when a probe hit a temp channel fail wall
          const tempFails = attempts.filter(n => n.type === tempChanFailType);

          // Generic failures are random hop traversal failures
          const genericFailures = attempts.filter(hop => {
            if (hop.type !== genericFailType) {
              return false;
            }

            const hasKnownOutcome = successes.concat(tempFails).find(n => {
              if (n.channel !== hop.channel) {
                return false;
              }

              return n.public_key === hop.public_key;
            });

            return !hasKnownOutcome;
          });

          // Stuck failures are unexpected timeouts across a route
          const stuckFailures = attempts.filter(hop => {
            if (hop.type !== stuckType) {
              return false;
            }

            const hasKnownOutcome = successes.concat(tempFails).find(n => {
              if (n.channel !== hop.channel) {
                return false;
              }

              return n.public_key === hop.public_key;
            });

            return !hasKnownOutcome;
          });

          return cbk(null, {
            generic_failures: genericFailures.map(n => ({
              channel: n.channel,
              public_key: n.public_key,
            })),
            route: route || undefined,
            stuck: stuckFailures.map(n => ({
              channel: n.channel,
              public_key: n.public_key,
            })),
            successes: successes.map(n => ({
              channel: n.channel,
              public_key: n.public_key,
            })),
            temporary_failures: tempFails.map(n => ({
              channel: n.channel,
              public_key: n.public_key,
            })),
          });
        });
      }],
    },
    returnResult({reject, resolve, of: 'probe'}, cbk));
  });
};
