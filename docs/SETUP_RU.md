# Настройка AFFiNE ↔ ChatGPT через Cloudflare Worker

Этот проект создаёт облачный **read-only** мост между ChatGPT и AFFiNE Cloud.

После настройки схема выглядит так:

```text
ChatGPT
   ↓ OAuth
Cloudflare Worker
   ↓ AFFiNE MCP credential
AFFiNE Cloud
```

Mac или другой постоянно включённый компьютер не нужен.

## Что понадобится

- AFFiNE Cloud workspace с MCP
- read-only MCP credential AFFiNE
- аккаунт Cloudflare с Workers
- GitHub аккаунт
- ChatGPT с поддержкой пользовательских MCP-приложений
- Node.js 24.11+ и npm

## 1. Установка

```bash
git clone https://github.com/excitingadventures8/affine-chatgpt-mcp-bridge.git
cd affine-chatgpt-mcp-bridge
npm ci
npx wrangler login
```

## 2. KV для OAuth

```bash
npx wrangler kv namespace create OAUTH_KV
```

Скопируйте полученный ID в `wrangler.jsonc` вместо:

```text
REPLACE_WITH_KV_NAMESPACE_ID
```

Имя binding должно оставаться `OAUTH_KV`.

## 3. Первый deploy

```bash
npm run deploy
```

Cloudflare выдаст адрес вида:

```text
https://affine-chatgpt-mcp-bridge.<ваш-subdomain>.workers.dev
```

## 4. GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

Укажите:

```text
Homepage URL:
https://<ваш-worker>.workers.dev

Authorization callback URL:
https://<ваш-worker>.workers.dev/callback
```

Сохраните Client ID и создайте Client Secret.

## 5. AFFiNE MCP

В AFFiNE создайте отдельный **read-only** MCP credential для нужного workspace.

Нужны:

```text
AFFINE_MCP_URL
```

например:

```text
https://app.affine.pro/api/workspaces/<workspace-id>/mcp
```

и полный заголовок авторизации:

```text
Bearer ...
```

Никогда не публикуйте credential в GitHub, чате или скриншотах.

## 6. Secrets Cloudflare

Выполните по очереди:

```bash
npx wrangler secret put AFFINE_MCP_URL
npx wrangler secret put AFFINE_AUTH_HEADER
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_GITHUB_USERS
```

`ALLOWED_GITHUB_USERS` — список GitHub login через запятую, например:

```text
mygithublogin
```

или:

```text
alice,bob
```

Если список пуст, мост специально запрещает авторизацию.

## 7. Финальный deploy

```bash
npm run deploy
```

## 8. Проверка защиты

```bash
curl -i https://<ваш-worker>.workers.dev/mcp
```

Без OAuth-токена ожидается `401` — это правильно.

Проверка OAuth metadata:

```bash
curl https://<ваш-worker>.workers.dev/.well-known/oauth-protected-resource/mcp
```

## 9. ChatGPT

Создайте пользовательское MCP-приложение:

```text
Server URL:
https://<ваш-worker>.workers.dev/mcp

Authentication:
OAuth
```

Авторизуйтесь через GitHub.

После успешного подключения ChatGPT должен увидеть:

```text
doc_search
read_document
```

## Что умеет мост

- искать документы AFFiNE;
- читать документы AFFiNE.

## Чего он намеренно не умеет

- создавать документы;
- редактировать записи;
- удалять данные;
- менять структуру AFFiNE.

Это ограничение сделано намеренно для безопасного публичного шаблона.

## Если AFFiNE отвечает 401

Создайте новый read-only MCP credential и заново задайте:

```bash
npx wrangler secret put AFFINE_AUTH_HEADER
```

Вводите полный рабочий заголовок `Bearer ...` без ручного сокращения или редактирования.

## Безопасность

Перед публикацией скриншота или лога проверяйте, что там нет:

- AFFiNE credential;
- GitHub Client Secret;
- Cloudflare API token;
- содержимого `.dev.vars`.

Если секрет был опубликован — отзовите его и создайте новый.
