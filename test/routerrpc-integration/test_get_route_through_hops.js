const {randomBytes} = require('crypto');

const {test} = require('tap');

const {addPeer} = require('./../../');
const {createCluster} = require('./../macros');
const {createInvoice} = require('./../../');
const {decodePaymentRequest} = require('./../../');
const {getRouteThroughHops} = require('./../../');
const {getRoutes} = require('./../../');
const {setupChannel} = require('./../macros');
const {waitForRoute} = require('./../macros');

const confirmationCount = 6;
const tokens = 100;

// Getting a route through hops should result in a route through specified hops
test(`Get route through hops`, async ({deepIs, end, equal}) => {
  const cluster = await createCluster({});

  const {lnd} = cluster.control;

  const controlToTargetChan = await setupChannel({
    lnd,
    generate: cluster.generate,
    to: cluster.target,
  });

  const targetToRemoteChan = await setupChannel({
    generate: cluster.generate,
    generator: cluster.target,
    lnd: cluster.target.lnd,
    to: cluster.remote,
  });

  await addPeer({
    lnd,
    public_key: cluster.remote.public_key,
    socket: cluster.remote.socket,
  });

  await cluster.generate({count: confirmationCount, node: cluster.target});

  const invoice = await createInvoice({
    tokens,
    is_including_private_channels: true,
    lnd: cluster.remote.lnd,
  });

  const {id} = invoice;
  const {request} = invoice;

  const decodedRequest = await decodePaymentRequest({lnd, request});

  await waitForRoute({
    lnd,
    destination: decodedRequest.destination,
    tokens: invoice.tokens,
  });

  const {routes} = await getRoutes({
    lnd,
    destination: decodedRequest.destination,
    routes: decodedRequest.routes,
    tokens: invoice.tokens,
  });

  const [route] = routes;

  try {
    const res = await getRouteThroughHops({
      lnd,
      mtokens: (BigInt(invoice.tokens) * BigInt(1e3)).toString(),
      public_keys: route.hops.map(n => n.public_key),
    });

    delete res.route.confidence;
    delete res.route.messages;
    delete res.route.payment;
    delete res.route.total_mtokens;
    delete route.confidence;
    delete route.payment;
    delete route.total_mtokens;

    deepIs(res.route, route, 'Constructed route to destination');
  } catch (err) {
    deepIs(err, [501, 'ExpectedRouterRpcWithGetRouteMethod'], 'Unimplemented');
  }

  await cluster.kill({});

  return end();
});
