/*
 * MeesaSplat - dependency-free 3D Gaussian splatting renderer.
 * Exposes window.MeesaSplat = { parsePly, mountSplatViewer }.
 * No imports, no CDN, no build step: inline this file in a static page.
 * Each splat is a camera-facing disc sized by its largest Gaussian axis.
 * Splats are sorted back-to-front on the CPU and composited with straight
 * alpha, so dense regions read as the source model instead of clipping white.
 */
(function () {
"use strict";
// PLY parsing
var TYPES = {
  char: [1, "i8"], int8: [1, "i8"], uchar: [1, "u8"], uint8: [1, "u8"],
  short: [2, "i16"], int16: [2, "i16"], ushort: [2, "u16"], uint16: [2, "u16"],
  int: [4, "i32"], int32: [4, "i32"], uint: [4, "u32"], uint32: [4, "u32"],
  float: [4, "f32"], float32: [4, "f32"], double: [8, "f64"], float64: [8, "f64"]
};
var FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
var DEFAULTS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], SH_C0 = 0.28209479177387814;
function tinfo(name) {
  var info = TYPES[name];
  if (!info) throw new Error("Unsupported PLY property type: " + name);
  return info;
}
function scalar(view, offset, kind, le) {
  switch (kind) {
    case "f32": return view.getFloat32(offset, le); case "f64": return view.getFloat64(offset, le);
    case "i8": return view.getInt8(offset); case "u8": return view.getUint8(offset);
    case "i16": return view.getInt16(offset, le); case "u16": return view.getUint16(offset, le);
    case "i32": return view.getInt32(offset, le); case "u32": return view.getUint32(offset, le);
    default: return 0;
  }
}
function findHeaderEnd(bytes) {
  var probe = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  var at = probe.indexOf("end_header");
  if (at < 0) throw new Error("PLY header is missing end_header");
  var nl = bytes.indexOf(10, at + 10);
  return nl < 0 ? bytes.length : nl + 1;
}
function parseHeader(text) {
  var lines = text.split(/\r?\n/), format = null, elements = [], current = null;
  if (lines[0].trim() !== "ply") throw new Error("Not a PLY file");
  for (var i = 1; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/);
    if (!parts[0] || parts[0] === "comment" || parts[0] === "obj_info") continue;
    if (parts[0] === "format") {
      format = parts[1];
      if (format === "binary_big_endian" || (format !== "ascii" && format !== "binary_little_endian"))
        throw new Error("Unsupported PLY format: " + format);
    } else if (parts[0] === "element") {
      current = { name: parts[1], count: parseInt(parts[2], 10) || 0, props: [] }; elements.push(current);
    } else if (parts[0] === "property") {
      if (!current) throw new Error("PLY property outside an element");
      if (parts[1] === "list") current.props.push({ name: parts[4], list: true, countType: parts[2], type: parts[3] });
      else current.props.push({ name: parts[2], list: false, type: parts[1] });
    } else if (parts[0] === "end_header") break;
  }
  if (!format) throw new Error("PLY header is missing a format line");
  return { format: format, elements: elements };
}
function scalarStride(el) {
  var stride = 0;
  for (var i = 0; i < el.props.length; i++) {
    if (el.props[i].list) return -1;
    stride += tinfo(el.props[i].type)[0];
  }
  return stride;
}
// Scalar rows jump by stride; list rows are walked so the cursor lands exactly
// on the next element.
function skipBinary(view, cursor, el, end) {
  var stride = scalarStride(el);
  if (stride >= 0) return Math.min(end, cursor + stride * el.count);
  for (var row = 0; row < el.count && cursor < end; row++) {
    for (var p = 0; p < el.props.length; p++) {
      var prop = el.props[p];
      if (prop.list) {
        var ci = tinfo(prop.countType), ii = tinfo(prop.type);
        cursor += ci[0] + Math.max(0, scalar(view, cursor, ci[1], true)) * ii[0];
      } else cursor += tinfo(prop.type)[0];
      if (cursor > end) return end;
    }
  }
  return Math.min(cursor, end);
}
function makeBounds(pos, count) {
  var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < count; i++) for (var k = 0; k < 3; k++) {
    var v = pos[i * 3 + k];
    if (!isFinite(v)) continue;
    if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }
  if (!isFinite(mn[0])) { mn = [-1, -1, -1]; mx = [1, 1, 1]; }
  return {
    min: { x: mn[0], y: mn[1], z: mn[2] }, max: { x: mx[0], y: mx[1], z: mx[2] },
    center: { x: (mn[0] + mx[0]) / 2, y: (mn[1] + mx[1]) / 2, z: (mn[2] + mx[2]) / 2 },
    size: { x: mx[0] - mn[0], y: mx[1] - mn[1], z: mx[2] - mn[2] } };
}
function alloc(count) {
  return {
    positions: new Float32Array(count * 3), colors: new Float32Array(count * 3),
    alphas: new Float32Array(count), radii: new Float32Array(count), quats: new Float32Array(count * 4)
  };
}
function storeSplat(out, index, values) {
  var i3 = index * 3, i4 = index * 4;
  for (var k = 0; k < 3; k++) {
    out.positions[i3 + k] = values[k];
    // Degree-0 spherical harmonic: color = 0.5 + C0 * f_dc.
    out.colors[i3 + k] = Math.min(1, Math.max(0, 0.5 + SH_C0 * values[3 + k]));
  }
  out.alphas[index] = 1 / (1 + Math.exp(-values[6])); // opacity is stored as a logit
  var r = Math.max(Math.exp(values[7]), Math.exp(values[8]), Math.exp(values[9]));
  out.radii[index] = isFinite(r) && r > 0 ? r : 1e-9;
  // rot_0..3 is (w, x, y, z). A zero quaternion degrades to identity.
  var qw = values[10], qx = values[11], qy = values[12], qz = values[13];
  var len = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz);
  if (len < 1e-12) { qw = 1; qx = qy = qz = 0; len = 1; }
  out.quats[i4] = qw / len; out.quats[i4 + 1] = qx / len;
  out.quats[i4 + 2] = qy / len; out.quats[i4 + 3] = qz / len;
}
function finishResult(out, count) {
  var positions = out.positions.subarray(0, count * 3);
  return {
    count: count, positions: positions, colors: out.colors.subarray(0, count * 3),
    alphas: out.alphas.subarray(0, count), radii: out.radii.subarray(0, count),
    quats: out.quats.subarray(0, count * 4), bounds: makeBounds(positions, count)
  };
}
function parseBinary(buffer, headerEnd, elements) {
  var bytes = new Uint8Array(buffer), view = new DataView(buffer), vertexIndex = -1;
  for (var e = 0; e < elements.length; e++) if (elements[e].name === "vertex") { vertexIndex = e; break; }
  if (vertexIndex < 0) throw new Error("PLY has no vertex element");
  var vertex = elements[vertexIndex], total = vertex.count, end = bytes.length, cursor = headerEnd;
  for (var prior = 0; prior < vertexIndex; prior++) cursor = skipBinary(view, cursor, elements[prior], end);
  // Fast path: all vertex properties scalar, so fixed offsets/stride keep extra
  // fields (nx, custom data) from shifting the required ones.
  var offsets = Object.create(null), stride = 0, hasList = false;
  for (var p = 0; p < vertex.props.length; p++) {
    var prop = vertex.props[p];
    if (prop.list) { hasList = true; continue; }
    offsets[prop.name] = stride;
    stride += tinfo(prop.type)[0];
  }
  var readers = FIELDS.map(function (name) {
    for (var q = 0; q < vertex.props.length; q++) {
      var found = vertex.props[q];
      if (found.name === name) return found.list ? null : { offset: offsets[name], kind: tinfo(found.type)[1] };
    }
    return null;
  });
  var available = hasList ? total : Math.min(total, Math.floor((end - cursor) / Math.max(stride, 1)));
  var out = alloc(available), values = new Float64Array(FIELDS.length), parsed = 0;
  if (!hasList) {
    for (var i = 0; i < available; i++) {
      var base = cursor + i * stride;
      for (var r = 0; r < readers.length; r++) {
        values[r] = readers[r] ? scalar(view, base + readers[r].offset, readers[r].kind, true) : DEFAULTS[r];
      }
      storeSplat(out, i, values); parsed++;
    }
  } else {
    // Rare: list properties inside the vertex element force a row walk.
    var ptr = cursor;
    for (var row = 0; row < total && ptr < end; row++) {
      values.set(DEFAULTS);
      var rowStart = ptr;
      for (var pr = 0; pr < vertex.props.length; pr++) {
        var pp = vertex.props[pr], ci = pp.list ? tinfo(pp.countType) : tinfo(pp.type);
        if (pp.list) ptr += ci[0] + Math.max(0, scalar(view, ptr, ci[1], true)) * tinfo(pp.type)[0];
        else {
          var fi = FIELDS.indexOf(pp.name);
          if (fi >= 0) values[fi] = scalar(view, ptr, ci[1], true);
          ptr += ci[0];
        }
      }
      if (ptr > end || ptr <= rowStart) break;
      storeSplat(out, parsed++, values);
    }
  }
  return finishResult(out, parsed);
}
function parseAscii(buffer, headerEnd, elements) {
  var tx = new TextDecoder("latin1").decode(new Uint8Array(buffer, headerEnd));
  var lines = tx.split(/\r?\n/).filter(function (line) { return line.trim().length > 0; });
  var lineIndex = 0, vertex = null;
  for (var e = 0; e < elements.length && !vertex; e++) {
    if (elements[e].name === "vertex") vertex = elements[e]; else lineIndex += elements[e].count;
  }
  if (!vertex) throw new Error("PLY has no vertex element");
  lineIndex = Math.min(lineIndex, lines.length);
  var out = alloc(vertex.count), values = new Float64Array(FIELDS.length), parsed = 0;
  for (var i = 0; i < vertex.count && lineIndex < lines.length; i++, lineIndex++) {
    var tokens = lines[lineIndex].trim().split(/\s+/), token = 0;
    values.set(DEFAULTS);
    for (var p = 0; p < vertex.props.length; p++) {
      var prop = vertex.props[p];
      if (prop.list) { token += 1 + Math.max(0, parseInt(tokens[token], 10) || 0); continue; }
      var fi = FIELDS.indexOf(prop.name);
      if (fi >= 0 && token < tokens.length) values[fi] = parseFloat(tokens[token]);
      token++;
    }
    storeSplat(out, parsed++, values);
  }
  return finishResult(out, parsed);
}
function parsePly(arrayBuffer) {
  if (!arrayBuffer || typeof arrayBuffer.byteLength !== "number") throw new Error("parsePly expects an ArrayBuffer");
  if (arrayBuffer.byteLength === 0) return finishResult(alloc(0), 0);
  var bytes = new Uint8Array(arrayBuffer), headerEnd = findHeaderEnd(bytes);
  var header = parseHeader(new TextDecoder("latin1").decode(bytes.subarray(0, headerEnd)));
  return header.format === "ascii" ? parseAscii(arrayBuffer, headerEnd, header.elements) : parseBinary(arrayBuffer, headerEnd, header.elements);
}
// Matrices (column-major, as WebGL expects) and GLSL
function perspective(fovy, aspect, near, far) {
  var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}
function lookAt(eye, target, up) {
  var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  var zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  var xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
  ]);
}
var VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform mat4 u_view, u_proj;
uniform vec2 u_viewport;
uniform float u_flipY;
uniform sampler2D u_data;
uniform usampler2D u_order;
uniform int u_orderW;
uniform int u_dataW;
out vec3 vColor;
out float vAlpha;
out vec2 vLocal;
void main() {
  int splat = gl_VertexID / 6;
  int ci = gl_VertexID - splat * 6;
  vec2 corner;
  if (ci == 0) corner = vec2(-1.0, -1.0);
  else if (ci == 1) corner = vec2(1.0, -1.0);
  else if (ci == 2) corner = vec2(-1.0, 1.0);
  else if (ci == 3) corner = vec2(1.0, -1.0);
  else if (ci == 4) corner = vec2(1.0, 1.0);
  else corner = vec2(-1.0, 1.0);
  // Sorted index texture: instance/splat 0 is the farthest from the camera.
  uint si = texelFetch(u_order, ivec2(splat % u_orderW, splat / u_orderW), 0).r;
  int s = int(si);
  ivec2 texel = ivec2((s % u_dataW) * 2, s / u_dataW);
  vec4 a = texelFetch(u_data, texel, 0);              // x, y, z, radius
  vec4 b = texelFetch(u_data, texel + ivec2(1, 0), 0); // r, g, b, alpha
  vec3 p = a.xyz;
  float radius = a.w;
  if (u_flipY > 0.5) p.yz = -p.yz; // 180 degrees about X
  vec4 viewPos = u_view * vec4(p, 1.0);
  vec4 clip = u_proj * viewPos;
  if (clip.w <= 0.0001) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  // Screen radius = focal_px * radius / depth, where focal_px for a vertical
  // FOV is 0.5 * viewportHeight * proj[1][1]. Offsetting in NDC and multiplying
  // by w keeps the quad exactly that many pixels wide after the divide.
  float focal = 0.5 * u_viewport.y * u_proj[1][1];
  float halfPx = clamp(focal * radius / clip.w, 1.0, 64.0);
  clip.xy += corner * halfPx * (2.0 / u_viewport) * clip.w;
  gl_Position = clip;
  vColor = b.rgb;
  vAlpha = b.a;
  vLocal = corner;
}`;
var FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor; in float vAlpha; in vec2 vLocal;
out vec4 outColor;
void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 1.0) discard;
  float a = clamp(vAlpha * exp(-4.0 * r2), 0.0, 1.0);
  if (a < 0.01) discard;
  // Straight alpha: SRC_ALPHA / ONE_MINUS_SRC_ALPHA performs the compositing.
  outColor = vec4(vColor, a);
}`;
function createProgram(gl) {
  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
      throw new Error("Shader compile failed: " + log);
    }
    return shader;
  }
  var vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER), fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  var program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    var log = gl.getProgramInfoLog(program); gl.deleteProgram(program);
    throw new Error("Program link failed: " + log);
  }
  return program;
}
// Viewer
function mountSplatViewer(container, options) {
  options = options || {};
  var stats = { total: 0, drawn: 0, fps: 0 }, destroyed = false, fatal = false, lost = false;
  var autoRotate = options.autoRotate !== false, flipY = !!options.flipY;
  var maxSplats = Math.max(1, Math.floor(options.maxSplats || 400000));
  var onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  var onStats = typeof options.onStats === "function" ? options.onStats : null;
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var instanceData = new Float32Array(0), fit = { radius: 1, center: [0, 0, 0] };
  var sortDirty = true, sortKeys = null, sortOrder = null, sortScratch = null, sortBits = null;
  var sortCounts = new Uint32Array(256), orderUpload = new Uint32Array(0), upAxis = "y";
  var yaw = 0, pitch = 0, zoom = 1, dragging = false, lastX = 0, lastY = 0;
  var raf = 0, lastTime = 0, frames = 0, fpsStart = 0, lastStatsAt = 0, fps = 0;
  if (typeof container === "string") container = document.querySelector(container);
  if (!container || !container.appendChild) {
    if (onProgress) try { onProgress({ phase: "error", message: "mountSplatViewer: container element is required" }); } catch (e) {}
    return { destroy: function () {}, reset: function () {}, setAutoRotate: function () {}, setFlipY: function () {}, getStats: function () { return { total: 0, drawn: 0, fps: 0, upAxis: "y" }; } };
  }
  var canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab;";
  container.appendChild(canvas);
  var gl = null, glr = null, observer = null;
  function progress(phase, extra) {
    if (!onProgress) return;
    try { onProgress(Object.assign({ phase: phase }, extra || {})); } catch (err) { /* gallery callback */ }
  }
  function reportError(err) {
    fatal = true; stats.fps = 0;
    progress("error", { message: err && err.message ? err.message : String(err) });
  }
  function emitStats(force) {
    if (!onStats) return;
    var now = performance.now();
    if (!force && now - lastStatsAt < 250) return;
    lastStatsAt = now;
    if (fpsStart) { fps = autoRotate && !dragging ? (frames * 1000) / Math.max(1, now - fpsStart) : 0; frames = 0; fpsStart = now; }
    try { onStats({ total: stats.total, drawn: stats.drawn, fps: Math.round(fps * 10) / 10 }); } catch (err) { /* ignore */ }
  }
  function resize() {
    if (destroyed) return;
    var rect = container.getBoundingClientRect ? container.getBoundingClientRect() : null;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(((rect && rect.width) || container.clientWidth || 300) * dpr));
    var h = Math.max(1, Math.round(((rect && rect.height) || container.clientHeight || 300) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; sortDirty = true; requestFrame(); }
  }
  function initGL() {
    var context = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (!context) throw new Error("WebGL2 is not available");
    gl = context;
    var program = createProgram(gl), vao = gl.createVertexArray();
    // Unit 0: two RGBA32F texels per splat (position+radius, color+alpha).
    var dataTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Unit 1: back-to-front splat indices as R32UI.
    var orderTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, orderTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_data"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_order"), 1);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // The color factors above are correct; use ONE for the alpha channel so
    // coverage accumulates instead of being multiplied by itself, which keeps
    // the transparent canvas correct on light or dark gallery backgrounds.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    glr = {
      program: program, vao: vao, dataTex: dataTex, orderTex: orderTex,
      dataW: 1, dataH: 1, orderW: 1, orderH: 1,
      uView: gl.getUniformLocation(program, "u_view"), uProj: gl.getUniformLocation(program, "u_proj"),
      uViewport: gl.getUniformLocation(program, "u_viewport"), uFlipY: gl.getUniformLocation(program, "u_flipY"),
      uOrderW: gl.getUniformLocation(program, "u_orderW"), uDataW: gl.getUniformLocation(program, "u_dataW")
    };
  }
  function uploadSplats() {
    if (!glr || !stats.drawn) return;
    var n = stats.drawn, maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var dataW = Math.max(1, Math.min(1024, n, Math.floor(maxTex / 2)));
    var dataH = Math.ceil(n / dataW);
    var orderW = Math.max(1, Math.min(1024, n, maxTex));
    var orderH = Math.ceil(n / orderW);
    var padded = new Float32Array(dataW * dataH * 8);
    padded.set(instanceData);
    orderUpload = new Uint32Array(orderW * orderH);
    glr.dataW = dataW; glr.dataH = dataH; glr.orderW = orderW; glr.orderH = orderH;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glr.dataTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, dataW * 2, dataH, 0, gl.RGBA, gl.FLOAT, padded);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glr.orderTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, orderW, orderH, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, orderUpload);
    gl.activeTexture(gl.TEXTURE0);
  }
  function fitDistance(aspect) {
    var vf = Math.PI / 4, hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    return (fit.radius / Math.sin(Math.min(vf, hf) / 2)) * 1.15; // 15% padding
  }
  function draw(now) {
    if (destroyed || lost || fatal || !glr || !gl) return;
    if (sortDirty) { sortSplats(); sortDirty = false; }
    gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (stats.drawn > 0) {
      var aspect = canvas.width / Math.max(1, canvas.height);
      var pitchCos = Math.cos(pitch), distance = fitDistance(aspect) * zoom;
      var cam = [fit.center[0] + Math.sin(yaw) * pitchCos * distance,
        fit.center[1] + Math.sin(pitch) * distance, fit.center[2] + Math.cos(yaw) * pitchCos * distance];
      var near = Math.max(distance * 0.01, 1e-6), far = distance * 4 + fit.radius * 8;
      gl.useProgram(glr.program);
      gl.uniformMatrix4fv(glr.uView, false, lookAt(cam, fit.center, [0, 1, 0]));
      gl.uniformMatrix4fv(glr.uProj, false, perspective(Math.PI / 4, aspect, near, far));
      gl.uniform2f(glr.uViewport, canvas.width, canvas.height); gl.uniform1f(glr.uFlipY, flipY ? 1 : 0);
      gl.uniform1i(glr.uOrderW, glr.orderW); gl.uniform1i(glr.uDataW, glr.dataW);
      gl.bindVertexArray(glr.vao); gl.drawArrays(gl.TRIANGLES, 0, stats.drawn * 6);
      gl.bindVertexArray(null);
    }
    frames++; if (!fpsStart) fpsStart = now; emitStats(false);
  }
  function requestFrame() {
    if (raf || destroyed || lost || fatal) return;
    raf = window.requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0;
    if (destroyed || lost || fatal) return;
    var dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;
    if (autoRotate && !dragging) { yaw += dt * 0.18; sortDirty = true; }
    try { draw(now); } catch (err) { reportError(err); return; }
    if (autoRotate && !dragging && stats.drawn > 0) requestFrame();
  }
  function reset() { yaw = 0; pitch = 0; zoom = 1; lastTime = 0; sortDirty = true; requestFrame(); }
  function setAutoRotate(value) { autoRotate = !!value; lastTime = 0; if (autoRotate) requestFrame(); }
  function setFlipY(value) { flipY = !!value; sortDirty = true; requestFrame(); }
  function getStats() { return { total: stats.total, drawn: stats.drawn, fps: Math.round(fps * 10) / 10, upAxis: upAxis }; }
  function onPointerDown(event) {
    if (event.button !== 0) return;
    dragging = true; lastX = event.clientX; lastY = event.clientY; lastTime = 0; canvas.style.cursor = "grabbing";
    if (canvas.setPointerCapture) try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
  }
  function onPointerMove(event) {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.01;
    pitch = Math.max(-1.45, Math.min(1.45, pitch + (event.clientY - lastY) * 0.01));
    lastX = event.clientX; lastY = event.clientY; sortDirty = true; requestFrame();
  }
  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false; canvas.style.cursor = "grab";
    if (canvas.releasePointerCapture) try { canvas.releasePointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    if (autoRotate) { lastTime = 0; requestFrame(); }
  }
  function onWheel(event) {
    event.preventDefault();
    zoom = Math.max(0.05, Math.min(20, zoom * Math.exp(event.deltaY * 0.001))); sortDirty = true; requestFrame();
  }
  function onContextLost(event) {
    event.preventDefault(); lost = true;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0; glr = null; gl = null;
  }
  function onContextRestored() {
    if (destroyed) return;
    lost = false;
    try { initGL(); uploadSplats(); sortDirty = true; requestFrame(); } catch (err) { reportError(err); }
  }
  canvas.addEventListener("wheel", onWheel, { passive: false });
  var listeners = [["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerUp],
    ["pointercancel", onPointerUp], ["webglcontextlost", onContextLost], ["webglcontextrestored", onContextRestored]];
  for (var li = 0; li < listeners.length; li++) canvas.addEventListener(listeners[li][0], listeners[li][1]);
  if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(resize); observer.observe(container); }
  else window.addEventListener("resize", resize);
  function buildInstances(source, drawn, step, axis) {
    var out = new Float32Array(drawn * 8);
    for (var i = 0; i < drawn; i++) {
      var k = step === 1 ? i : Math.floor(i * step), o = i * 8, s = k * 3;
      var x = source.positions[s], y = source.positions[s + 1], z = source.positions[s + 2];
      // Rotate the longest axis upright; sorting and framing use these coords.
      if (axis === "x") { var t = x; x = -y; y = t; }
      else if (axis === "z") { var u = y; y = z; z = -u; }
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = source.radii[k];
      out[o + 4] = source.colors[s]; out[o + 5] = source.colors[s + 1]; out[o + 6] = source.colors[s + 2];
      out[o + 7] = source.alphas[k];
    }
    return out;
  }
  function orientedExtent(b, axis) {
    if (axis === "x") return { x: b.size.y, y: b.size.x, z: b.size.z, cx: -b.center.y, cy: b.center.x, cz: b.center.z };
    if (axis === "z") return { x: b.size.x, y: b.size.z, z: b.size.y, cx: b.center.x, cy: b.center.z, cz: -b.center.y };
    return { x: b.size.x, y: b.size.y, z: b.size.z, cx: b.center.x, cy: b.center.y, cz: b.center.z };
  }
  function sortSplats() {
    var n = stats.drawn;
    if (!n || !glr) return;
    var aspect = canvas.width / Math.max(1, canvas.height);
    var pitchCos = Math.cos(pitch), distance = fitDistance(aspect) * zoom;
    var ex = fit.center[0] + Math.sin(yaw) * pitchCos * distance;
    var ey = fit.center[1] + Math.sin(pitch) * distance;
    var ez = fit.center[2] + Math.cos(yaw) * pitchCos * distance;
    // Forward vector from eye to orbit centre.
    var fx = -Math.sin(yaw) * pitchCos, fy = -Math.sin(pitch), fz = -Math.cos(yaw) * pitchCos;
    var flip = flipY ? -1 : 1;
    for (var i = 0; i < n; i++) {
      var o = i * 8;
      // View-space depth; farthest splats must be composited first.
      var d = (instanceData[o] - ex) * fx + (instanceData[o + 1] * flip - ey) * fy + (instanceData[o + 2] * flip - ez) * fz;
      sortKeys[i] = d > 0 ? d : 0;
    }
    for (var j = 0; j < n; j++) sortOrder[j] = j;
    // 8-bit radix passes over positive-float bit patterns: O(4n), no comparator.
    var bits = sortBits, counts = sortCounts, src = sortOrder, dst = sortScratch;
    for (var shift = 0; shift < 32; shift += 8) {
      counts.fill(0);
      for (var a = 0; a < n; a++) counts[(bits[src[a]] >>> shift) & 255]++;
      var total = 0;
      for (var b = 0; b < 256; b++) { var c = counts[b]; counts[b] = total; total += c; }
      for (var m = 0; m < n; m++) { var idx = src[m]; dst[counts[(bits[idx] >>> shift) & 255]++] = idx; }
      var sw = src; src = dst; dst = sw;
    }
    // Ascending depth, emitted in reverse so texture order 0 is farthest.
    for (var p = 0; p < n; p++) orderUpload[p] = src[n - 1 - p];
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glr.orderTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, glr.orderW, glr.orderH, gl.RED_INTEGER, gl.UNSIGNED_INT, orderUpload);
    gl.activeTexture(gl.TEXTURE0);
  }
  function start() {
    try {
      if (!options.url) throw new Error("mountSplatViewer: options.url is required");
      initGL(); resize();
      progress("fetch", { url: options.url });
      var request = controller ? fetch(options.url, { signal: controller.signal }) : fetch(options.url);
      request.then(function (response) {
        if (!response.ok) throw new Error("Failed to fetch splat file: HTTP " + response.status);
        return response.arrayBuffer();
      }).then(function (buffer) {
        if (destroyed) return;
        progress("parse", { bytes: buffer.byteLength });
        var data = parsePly(buffer), total = data.count;
        var step = total > maxSplats ? total / maxSplats : 1, drawn = Math.min(total, maxSplats);
        var size = data.bounds.size, longest = Math.max(size.x, size.y, size.z);
        // Keep Y up unless it is squashed relative to the longest axis.
        upAxis = size.y >= 0.4 * longest ? "y" : (size.x >= size.z ? "x" : "z");
        instanceData = buildInstances(data, drawn, step, upAxis);
        sortKeys = new Float32Array(drawn);
        sortBits = new Uint32Array(sortKeys.buffer);
        sortOrder = new Uint32Array(drawn);
        sortScratch = new Uint32Array(drawn);
        var ob = orientedExtent(data.bounds, upAxis);
        fit = { radius: 0.5 * Math.max(ob.x, ob.y, ob.z) || 0.5, center: [ob.cx, ob.cy, ob.cz] };
        stats.total = total; stats.drawn = drawn; stats.upAxis = upAxis;
        uploadSplats();
        sortDirty = true;
        progress("ready", { total: total, drawn: drawn, upAxis: upAxis }); emitStats(true); requestFrame();
      }).catch(function (err) {
        if (!destroyed && !(err && err.name === "AbortError")) reportError(err);
      });
    } catch (err) { reportError(err); }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    if (controller) try { controller.abort(); } catch (err) { /* ignore */ }
    if (observer) observer.disconnect(); else window.removeEventListener("resize", resize);
    canvas.removeEventListener("wheel", onWheel);
    for (var li = 0; li < listeners.length; li++) canvas.removeEventListener(listeners[li][0], listeners[li][1]);
    try {
      if (gl && glr) {
        gl.deleteTexture(glr.dataTex); gl.deleteTexture(glr.orderTex);
        gl.deleteVertexArray(glr.vao); gl.deleteProgram(glr.program);
      }
    } catch (err) { /* context may already be gone */ }
    glr = null; gl = null;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    instanceData = new Float32Array(0); orderUpload = new Uint32Array(0);
    stats.total = 0; stats.drawn = 0;
  }
  start();
  return { destroy: destroy, reset: reset, setAutoRotate: setAutoRotate, setFlipY: setFlipY, getStats: getStats };
}
window.MeesaSplat = { parsePly: parsePly, mountSplatViewer: mountSplatViewer };
})();
