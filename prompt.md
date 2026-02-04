I want you to make a nobuild web app. That means all JS imports are either relative paths or URLs, use esm for url imports. No nodejs. It should have an index.html,
  and a main.js. We are going to build a gas simulator using the canvas API. There are three main systems, the canvas system, the map system, and the simulator system.
  There should be a canvas.js that controls setting up a drag pan/zoom system on an infinite canvas. The canvas should be capable of receiving a "world", which is a
  list of things to render; polygons, lines, points with labels, radial gradients etc. If there is an array inside the world array, the canvas should just iterate over
  the inner elements (this allows for groups of rendered items). If there is a "inherit" attribute, then styling (ex: line thickness) on that inherit attribute should
  be used as a fallback for any information that is on the main object. Ex: (if no thing.color, check thing.inherit.color). There should be a "control" system where
  something outside of the canvas gets control of the canvas's input events (clicks, dragging, etc) and those events are augmented with the coordinate system of the
  infinite canvas (ex: user clicked at coordinate). There should be a way for the external system to take control and release control of the input events. This canvas
  system should be fairly generic and reusable. The top level of the canvas system should accept a width/height and then return an object that contains the canvas
  element and helper methods (for adding/removing objects in the world and input event control). The mapping system is more specific than the canvas system. It should
  take a canvas object as an input and return an object that contains both an html element (which will contain buttons for things like adding/removing things from the
  map, saving/loading the map, etc) and the output object should also have helper methods for controlling/modifying the map. The map is going to have specific kinds of
  objects; "markers" which are labelled points, "routes" which are a sequential list of points (lines inbetween), "obstacles" which are rectangles, and "gasNodes" which
  will be a gaussian with a specific radius and a peak concentration value representing a gas cloud. Each of these objects should have an "asCanvas" value (not method)
  that will be added to the canvas render list (e.g. they conform to the API that the canvas expects for rendering). Most of these asCanvas values should be an array.
  Each element in the array should contain a reference back to the specific map object so that, given a canvas element we can get the map object that owns it. The map
  should be serializable as yaml. The canvas style of a map object (line thickness, color, etc) should use "inherit" and inherit from a top level style for each type
  of object (e.g. one "obstacle" style). That info should be in the yaml. When the map yaml is loaded with the load button, all elements from the canvas should be
  cleared before adding all the new canvas elements. There should be a way to graphically create a new obstacle, marker, gas point, or route. Use the canvas control
  api to listen to click events and get the right coordinates. Finally the simulator system. The simulator should take both a map object and a canvas object. It should
  add a robot rectangle to the canvas and use the map object to calculate a gas concentration value based on gas points. Take the max gas value (don't add them) based
  on the distance from the points, their gaussian, and their max concentration value. The robot should be controllable by WASD. When moving the robot, it should mutate
  the rectangle object that is getting rendered (and the canvas will just render it correctly). The current gas concentration value should be displayed as an html
  element on the right side of the screen. There should be helper methods for moving the robot forward, backward, left, right, and rotating left or right a certain
  number of degrees. Do not ask me for clarification on this first run just create a plan, iterate and recheck your plan. Write clean code with jsdoc examples for the
  methods of each of the three systems. Write tests in a separate file for the map and separate file for the robot system (the parts that don't involve html elements),
  but don't write tests for canvas. I don't want to mock or stub things in tests (no fake DOM).