// Restricted Magpie Agent adapter: no Node/Bun APIs run here.
export const agent = {
  id: "quality-monitor",
  name: "降智监测",
  config: "~/.magpie-quality-monitor/connection.json",
  format: "json",
  dir: "~/.magpie-quality-monitor",
  ua: ["magpie-quality-monitor"],
  notice: "回到降智监测页面选择模型并启用对象；新建对象默认暂停。",
};
export function connect({ gateway, models }) {
  return { baseURL: gateway.v1, apiKey: gateway.key, models: models || [] };
}
