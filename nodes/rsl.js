'use strict';

// Node-RED requires constructor functions for registration. All RSL behavior is
// compiled separately with functional TypeScript; these nodes hold descriptions.
module.exports = function registerRslNodes(RED) {
  const types = ['rsl-source', 'rsl-map', 'rsl-filter', 'rsl-scan', 'rsl-take', 'rsl-delay',
    'rsl-debounce-time', 'rsl-switch-map', 'rsl-combine-latest', 'rsl-share-replay', 'rsl-input', 'rsl-sink'];
  function RslDescription(config) {
    RED.nodes.createNode(this, config);
    this.on('input', (_message, _send, done) => {
      const error = new Error('Use Run in the RSL sidebar to subscribe to this graph.');
      if (done) done(error); else this.error(error);
    });
  }
  for (const type of types) RED.nodes.registerType(type, RslDescription);
};
