# 对接协议

正式对接契约为 [独立协议 v1](docs/standalone-protocol.md)，机器可读版本见 [OpenAPI](openapi/standalone-v1.json)。

业务前缀 `/api/v1`；所有业务与管理请求均要求 Bearer 凭据。接入者无需提供 QQ-Agent 目录、配置或存档格式。

旧 `/api/vec` 路由仅作为内部兼容实现保留，不是新项目的接入接口。
