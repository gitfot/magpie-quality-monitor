import sanitize from "sanitize-html";
import type { TestItem, Execution } from "./types.ts";

export const answerInstruction =
  "\n\n先给出解题过程，最后单独一行输出：\nFINAL_ANSWER: <答案>";
export const drawingInstruction =
  "\n\n只输出完整 HTML，使用 HTML/CSS/内联 SVG。禁止 JavaScript、外部资源、表单和跳转。不使用 Markdown 代码围栏。";
export const previewPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; sandbox";
export function grade(
  raw: string,
  test: TestItem,
): Pick<Execution, "verdict" | "answer"> {
  if (test.gradingMode === "full-text") {
    const answer = test.answers.find((a) => {
      const escaped = a.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
        "u",
      ).test(raw);
    });
    return {
      verdict: answer === undefined ? "incorrect" : "correct",
      answer: answer?.trim() ?? null,
    };
  }
  const matches = [...raw.matchAll(/^FINAL_ANSWER:[ \t]*(.*)$/gm)];
  if (matches.length !== 1 || !matches[0][1].trim())
    return { verdict: "format", answer: null };
  const answer = matches[0][1].trim();
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .replace(/\s+/gu, "")
      .replace(/[.。]+$/u, "");
  return {
    verdict: test.answers.some((a) =>
      test.answerRule === "normalized-v1"
        ? normalize(a) === normalize(answer)
        : a.trim() === answer,
    )
      ? "correct"
      : "incorrect",
    answer,
  };
}
export function extract(raw: string): {
  artifact: string | null;
  extraction: string;
} {
  const fence = raw.trim().match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  const html = fence ? fence[1] : raw.trim();
  if (
    !/<html(?:\s|>)/i.test(html) ||
    !/<\/html\s*>\s*$/i.test(html) ||
    !/<(?:body|svg)(?:\s|>)/i.test(html)
  )
    return {
      artifact: null,
      extraction: "未找到完整 HTML 文档；未修补原始输出",
    };
  return {
    artifact: html,
    extraction: fence
      ? "提取 HTML 代码围栏；原始回答保留，未修补"
      : "直接提取完整 HTML；未修补",
  };
}
const svgPresentation = [
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "vector-effect",
  "paint-order",
  "color",
  "display",
  "visibility",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
];
const svgAttributes: Record<string, string[]> = {
  svg: [
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "xmlns",
    "xmlns:xlink",
    "preserveAspectRatio",
  ],
  g: [],
  defs: [],
  symbol: ["viewBox", "preserveAspectRatio"],
  use: ["href", "xlink:href", "x", "y", "width", "height"],
  path: ["d", "pathLength"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "x2", "y1", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  text: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
  tspan: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
  linearGradient: [
    "x1",
    "x2",
    "y1",
    "y2",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "href",
    "xlink:href",
  ],
  radialGradient: [
    "cx",
    "cy",
    "r",
    "fx",
    "fy",
    "fr",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "href",
    "xlink:href",
  ],
  stop: ["offset", "stop-color", "stop-opacity"],
  clipPath: ["clipPathUnits"],
  mask: [
    "x",
    "y",
    "width",
    "height",
    "maskUnits",
    "maskContentUnits",
    "mask-type",
  ],
  marker: [
    "viewBox",
    "refX",
    "refY",
    "markerWidth",
    "markerHeight",
    "orient",
    "markerUnits",
    "preserveAspectRatio",
  ],
  filter: ["x", "y", "width", "height", "filterUnits", "primitiveUnits"],
  feGaussianBlur: ["stdDeviation", "in", "result"],
  feOffset: ["dx", "dy", "in", "result"],
  feBlend: ["in", "in2", "mode", "result"],
  feColorMatrix: ["in", "type", "values", "result"],
};
const animationAttributes = [
  "attributeName",
  "attributeType",
  "href",
  "xlink:href",
  "from",
  "to",
  "by",
  "values",
  "dur",
  "begin",
  "end",
  "repeatCount",
  "repeatDur",
  "min",
  "max",
  "restart",
  "fill",
  "calcMode",
  "keyTimes",
  "keySplines",
  "additive",
  "accumulate",
];
// Declarative animation may change geometry, never URLs, style, IDs or events.
const animatable = new Set([
  "d",
  "points",
  "transform",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "width",
  "height",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "stroke-width",
  "stroke-dashoffset",
  "stroke-dasharray",
]);
const transformTypes = new Set([
  "translate",
  "scale",
  "rotate",
  "skewX",
  "skewY",
]);
const fragment = /^#[^\s\u0000-\u001f\u007f"'<>\\]+$/u;
const localResource = /^url\(\s*(["']?)#[^\s"'()<>\\]+\1\s*\)$/;

// Sanitizing removes navigation primitives; CSP and an empty iframe sandbox are
// independent barriers. The untouched model response remains in the record.
export function preview(html: string): string {
  return sanitize(html, {
    allowedTags: [
      "html",
      "head",
      "body",
      "title",
      "style",
      "main",
      "section",
      "article",
      "header",
      "footer",
      "nav",
      "aside",
      "div",
      "span",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "br",
      "hr",
      "strong",
      "em",
      "b",
      "i",
      "small",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "figure",
      "figcaption",
      "svg",
      "desc",
      "g",
      "defs",
      "symbol",
      "use",
      "animate",
      "animateTransform",
      "path",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "text",
      "tspan",
      "linearGradient",
      "radialGradient",
      "stop",
      "clipPath",
      "mask",
      "marker",
      "filter",
      "feGaussianBlur",
      "feOffset",
      "feBlend",
      "feColorMatrix",
    ],
    allowedAttributes: {
      "*": [
        "id",
        "class",
        "style",
        "role",
        "aria-label",
        "aria-labelledby",
        "aria-describedby",
      ],
      ...Object.fromEntries(
        Object.entries(svgAttributes).map(([tag, attributes]) => [
          tag,
          [...svgPresentation, ...attributes],
        ]),
      ),
      animate: animationAttributes,
      animateTransform: [...animationAttributes, "type"],
    },
    transformTags: {
      "*": (tagName, attribs) => {
        for (const name of ["href", "xlink:href"])
          if (name in attribs && !fragment.test(attribs[name]))
            delete attribs[name];
        for (const name of [
          "filter",
          "clip-path",
          "mask",
          "marker-start",
          "marker-mid",
          "marker-end",
        ])
          if (
            name in attribs &&
            attribs[name] !== "none" &&
            !localResource.test(attribs[name])
          )
            delete attribs[name];
        return { tagName, attribs };
      },
    },
    exclusiveFilter: ({ tag, attribs }) =>
      (tag === "animate" || tag === "animateTransform") &&
      (!animatable.has(attribs.attributeName) ||
        (tag === "animateTransform" &&
          (attribs.attributeName !== "transform" ||
            !transformTypes.has(attribs.type)))),
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowVulnerableTags: true,
    allowedSchemes: [],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    nestingLimit: 100,
  });
}
