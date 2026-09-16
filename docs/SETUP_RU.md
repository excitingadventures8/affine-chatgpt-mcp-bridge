# Настройка AFFiNE ↔ ChatGPT через Cloudflare Worker

Этот проект создаёт облачный **read-only** мост между ChatGPT и AFFiNE Cloud.

ChatGPT проходит GitHub OAuth в Cloudflare Worker. Worker читает текст через
AFFiNE MCP. Дополнительные инструменты владельца используют существующую
веб-сессию AFFiNE после повторной проверки доступа к документу через MCP.

Версия 1.3.5 добавляет чтение изображений, структуры и диагностику.
[Общее руководство по организации пространства и работе ИИ](WORKSPACE_AND_AI_GUIDE_RU.md)
описывает правила чтения контекста, просмотра и согласования изменений.

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

## 7. Дополнительные инструменты владельца и финальный deploy

Для изображений, структуры и диагностики замените примеры в исходниках:

- `OWNER_LOGIN` в `src/affine-media/bridge.mjs` — точный GitHub login владельца;
- `WORKSPACE_ID` в `src/affine-media/media.mjs` — workspace из `AFFINE_MCP_URL`.

Владелец также должен входить в `ALLOWED_GITHUB_USERS`. Сохраните существующую
авторизованную веб-сессию AFFiNE в Worker Secret:

```bash
npx wrangler secret put AFFINE_SESSION_COOKIE
```

Cookie не передаётся через аргументы инструментов. Без него чтение через
дополнительный транспорт не работает; обычные текстовые инструменты используют
свой отдельный MCP credential. Дополнительные разрешённые GitHub-пользователи
получают только текстовые инструменты.

Личные значения владельца и workspace оставляйте в локальной настройке исходников;
не отправляйте идентификатор частного пространства в публичный репозиторий.
`PILOT_DOCUMENT_ID` — пример для тестов, его не нужно заменять живым документом.

При обновлении существующего Worker сохраните его имя, KV, историю migrations,
OAuth и секреты. `wrangler.jsonc` из репозитория — шаблон новой установки;
он не заменяет настройки уже работающего развёртывания.

Проверки перед публикацией:

```bash
npm test
npm run type-check
npx wrangler deploy --dry-run
```

Затем:

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

Обычный разрешённый пользователь видит:

```text
doc_search
read_document
```

Для настроенного владельца также доступны `affine_list_sections`,
`affine_list_images`, `affine_read_image`, `affine_read_structure`,
`affine_write_diagnostics` и `affine_sync_diagnostics`.
Если клиент сохранил старый каталог, обновите инструменты подключения.

## Что умеет мост

- искать документы AFFiNE;
- читать документы AFFiNE;
- читать группы, изображения, таблицы, строки, теги и связи;
- проверять права и этапы синхронизации без отправки изменений.

## Чего он намеренно не умеет

- создавать документы;
- редактировать записи;
- удалять данные;
- менять структуру AFFiNE.

Это ограничение сделано намеренно для безопасного публичного шаблона.

`Doc.Update = true` не означает, что Bridge умеет записывать. В живой проверке
1.3.5 оба выбранных документа получили `TIMEOUT` на этапе `document_join`:
снимок и запись не подтверждены. Подробности — [VALIDATION.md](VALIDATION.md).

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
