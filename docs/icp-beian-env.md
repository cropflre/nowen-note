# ICP 备案号配置

nowen-note 的 Web 登录页备案号由运行时环境变量驱动，不再在「设置 → 外观」里编辑。

## 环境变量

| 变量名 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `NOWEN_ICP_BEIAN` | 空 | Web 登录页底部展示的 ICP 备案号；为空则不展示 |
| `ICP_BEIAN` | 空 | 兼容别名；优先级低于 `NOWEN_ICP_BEIAN` |

## Docker 示例

```bash
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /opt/nowen-note/data:/app/data \
  -e DB_PATH=/app/data/nowen-note.db \
  -e NOWEN_ICP_BEIAN="粤ICP备XXXXXXXX号-X" \
  nowen-note
```

## docker-compose 示例

```yaml
services:
  nowen-note:
    image: nowen-note
    ports:
      - "3001:3001"
    volumes:
      - /opt/nowen-note/data:/app/data
    environment:
      DB_PATH: /app/data/nowen-note.db
      NOWEN_ICP_BEIAN: 粤ICP备XXXXXXXX号-X
```

修改后需要重启容器生效。
