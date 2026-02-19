import {
  createMapData,
  serializeMap,
  deserializeMap,
  markerAsCanvas,
  obstacleAsCanvas,
  gasNodeAsCanvas,
  routeAsCanvas,
  buildAsCanvas,
} from '../map.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const mapData = createMapData();
mapData.markers.push({ id: 'm1', x: 1, y: 2, label: 'A' });
mapData.obstacles.push({ id: 'o1', x: 5, y: 6, w: 10, h: 12 });
mapData.gasNodes.push({ id: 'g1', x: 0, y: 0, radius: 20, peak: 1.2 });
mapData.routes.push({ id: 'r1', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });

const yamlText = serializeMap(mapData);
const reloaded = deserializeMap(yamlText);
assert(reloaded.markers.length === 1, 'marker should roundtrip');
assert(reloaded.styles.marker, 'styles should exist after load');

const markerCanvas = markerAsCanvas(mapData.markers[0], mapData.styles);
assert(Array.isArray(markerCanvas), 'marker asCanvas should be array');
assert(markerCanvas[0].inherit === mapData.styles.marker, 'marker should inherit marker style');

const obstacleCanvas = obstacleAsCanvas(mapData.obstacles[0], mapData.styles);
assert(obstacleCanvas[0].inherit === mapData.styles.obstacle, 'obstacle should inherit obstacle style');

const gasCanvas = gasNodeAsCanvas(mapData.gasNodes[0], mapData.styles);
assert(gasCanvas[0].type === 'radialGradient', 'gas node should include radial gradient');

const routeCanvas = routeAsCanvas(mapData.routes[0], mapData.styles);
assert(routeCanvas[0].type === 'line', 'route should include line');

const world = buildAsCanvas(mapData);
assert(world.length === 4, 'world should include four groups');

console.log('map.test.js passed');
