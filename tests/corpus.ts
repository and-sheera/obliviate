import type { Term } from '../src/core/types';

export interface Case {
  name: string;
  text: string;
  /** substrings that MUST be found (gone once everything found is replaced) */
  hide?: string[];
  /** substrings that MUST NOT be found */
  keep?: string[];
  /** placeholders that must appear */
  has?: string[];
  /** placeholders that must NOT appear */
  notHas?: string[];
  dict?: Term[];
  /** false-positive guard: nothing at all is found */
  noop?: true;
}

const L = (...lines: string[]) => lines.join('\n');

// fake but pattern-conformant credentials (split where GitHub push protection would flag them)
const OPENAI = 'sk-proj-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3gH6jK9m';
const ANTHROPIC = 'sk-ant-api03-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3gH6jK9mN2pQ5sT8vW1yZ4bC7dF0gH3-AbCdEfGh';
const AWS_ID = 'AKIAJ3XK9Q2LM8VN4RT5';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GH = 'ghp_1A2b3C4d5E6f7G8h9I0jK1lM2nO3pQ4rS5tU';
const SLACK = 'xoxb' + '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
const GOOGLE = 'AIzaSyD4kR8mN2pQ5sT7vW9yZ1bC3dF6gH8jK0l';
const STRIPE = 'sk_live' + '_51HxYz2AbCdEfGhIjKlMnOpQr';
const TG_BOT = '123456789:AAH3kR8mN2pQ5sT7vW9yZ1bC3dF6gH8jK0l';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const NPM = 'npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PEM = L(
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAz3Xk9Qw2LmN8vRt5YbH7cJ4dF6gA1sPqW0eUiO3xZ9kBnMvC',
  'lD2fG5hJ8kL1zX4cV7bN0mQ3wE6rT9yUiO2pAsDfGhJkLzXcVbNmQwErTyUiOpAs',
  '-----END RSA PRIVATE KEY-----',
);

export const corpus: Case[] = [
  // ───────────── API keys & tokens ─────────────
  {
    name: 'env: OpenAI key',
    text: L(`OPENAI_API_KEY=${OPENAI}`, 'NODE_ENV=production', 'PORT=3000'),
    hide: [OPENAI],
    keep: ['OPENAI_API_KEY=', 'NODE_ENV=production', 'PORT=3000'],
    has: ['[API_KEY_1]'],
  },
  {
    name: 'env: Anthropic key',
    text: `ANTHROPIC_API_KEY="${ANTHROPIC}"`,
    hide: [ANTHROPIC, 'api03'],
    keep: ['ANTHROPIC_API_KEY='],
    has: ['[API_KEY_1]'],
  },
  {
    name: 'env: AWS id + secret',
    text: L(`AWS_ACCESS_KEY_ID=${AWS_ID}`, `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, 'AWS_REGION=eu-west-1'),
    hide: [AWS_ID, AWS_SECRET],
    keep: ['AWS_REGION=eu-west-1'],
  },
  {
    name: 'git: token inside clone url',
    text: `git clone https://${GH}@github.com/acme/private-repo.git`,
    hide: [GH],
    keep: ['git clone https://', '@github.com/acme/private-repo.git'],
  },
  {
    name: 'mixed provider keys',
    text: L(
      `slack: ${SLACK}`,
      `maps: ${GOOGLE}`,
      `billing: ${STRIPE}`,
      `bot: ${TG_BOT}`,
    ),
    hide: [SLACK, GOOGLE, STRIPE, TG_BOT, 'AAH3kR8'],
  },
  {
    name: 'telegram bot token inside url',
    text: `curl https://api.telegram.org/bot${TG_BOT}/sendMessage -d chat_id=1`,
    hide: [TG_BOT],
    keep: ['curl https://api.telegram.org/bot', '/sendMessage -d chat_id=1'],
  },
  {
    name: 'curl: JWT bearer',
    text: `curl -H "Authorization: Bearer ${JWT}" https://api.internal.acme.io/v1/users`,
    hide: [JWT, 'eyJhbGci'],
    keep: ['curl -H "Authorization: Bearer ', 'https://api.internal.acme.io/v1/users'],
    has: ['[TOKEN_1]'],
  },
  {
    name: 'opaque bearer + basic',
    text: L('Authorization: Bearer 8f14e45fceea167a5a36dedd4bea2543', 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=='),
    hide: ['8f14e45fceea167a5a36dedd4bea2543', 'dXNlcjpwYXNzd29yZDEyMw=='],
    keep: ['Authorization: Bearer ', 'Authorization: Basic '],
  },
  {
    name: 'npmrc auth token',
    text: `//registry.npmjs.org/:_authToken=${NPM}`,
    hide: [NPM],
    keep: ['//registry.npmjs.org/:_authToken='],
  },
  {
    name: 'PEM private key',
    text: L('Вот мой ключ, помоги понять, почему не работает ssh:', PEM, 'Ошибка: Permission denied (publickey).'),
    hide: [PEM, 'MIIEowIBAAKC', 'lD2fG5hJ8k'],
    keep: ['помоги понять', 'Permission denied (publickey).'],
    has: ['[PRIVATE_KEY_1]'],
  },

  // ───────────── connection strings ─────────────
  {
    name: 'postgres url with credentials and internal host',
    text: 'DATABASE_URL=postgres://app_user:Sup3rS3cret!@db-01.prod.internal:5432/appdb',
    hide: ['app_user', 'Sup3rS3cret!', 'db-01.prod.internal'],
    keep: ['DATABASE_URL=postgres://', ':5432/appdb'],
  },
  {
    name: 'redis url with empty user',
    text: 'REDIS_URL=redis://:hunter2pass@cache.corp:6379/0',
    hide: ['hunter2pass', 'cache.corp'],
    keep: ['redis://', ':6379/0'],
  },
  {
    name: 'mongodb+srv',
    text: 'mongodb+srv://admin:P4ssw0rdXYZ@cluster0.abcde.mongodb.net/prod?retryWrites=true',
    hide: ['P4ssw0rdXYZ'],
    keep: ['mongodb+srv://', 'cluster0.abcde.mongodb.net/prod?retryWrites=true'],
  },

  // ───────────── credentials by context ─────────────
  {
    name: 'json login form',
    text: '{"username": "admin", "password": "P@ssw0rd!2024", "remember": true}',
    hide: ['admin', 'P@ssw0rd!2024'],
    keep: ['"username"', '"password"', '"remember": true'],
  },
  {
    name: 'yaml db block',
    text: L('db:', '  user: postgres', '  password: qwerty123', '  host: 10.20.30.40', '  port: 5432'),
    hide: ['postgres', 'qwerty123', '10.20.30.40'],
    keep: ['db:', '  port: 5432'],
  },
  {
    name: 'ru: login and password in chat',
    text: 'Логин: ivan.petrov, пароль: Zx9!kLm2, зайди на сервер и проверь логи.',
    hide: ['ivan.petrov', 'Zx9!kLm2'],
    keep: ['зайди на сервер и проверь логи.'],
    has: ['[LOGIN_1]', '[PASSWORD_1]'],
  },
  {
    name: 'ru: "пароль от X" phrasing with quotes',
    text: 'Пароль от админки: "мой секретный пароль 123" — не потеряй.',
    hide: ['мой секретный пароль 123'],
    keep: ['Пароль от админки:', '— не потеряй.'],
  },
  {
    name: 'ru: dash separator',
    text: 'пароль от wifi — Gh7#pLq9xZ',
    hide: ['Gh7#pLq9xZ'],
    keep: ['пароль от wifi'],
  },
  {
    name: 'sql: create user with password',
    text: "CREATE USER reporter WITH PASSWORD 'r3p0rt_pw'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporter;",
    hide: ['r3p0rt_pw'],
    keep: ['CREATE USER reporter WITH PASSWORD', 'GRANT SELECT ON ALL TABLES'],
  },
  {
    name: 'docker-compose env list',
    text: L('services:', '  db:', '    image: postgres:16', '    environment:', '      - POSTGRES_USER=shop', '      - POSTGRES_PASSWORD=changeme_prod_9', '      - POSTGRES_DB=shop'),
    hide: ['changeme_prod_9'],
    keep: ['image: postgres:16', 'POSTGRES_DB=shop'],
  },
  {
    name: 'python code with hardcoded key',
    text: L('import openai', `client = openai.OpenAI(api_key="${OPENAI}", timeout=30)`, 'print(client.models.list())'),
    hide: [OPENAI],
    keep: ['import openai', 'timeout=30)', 'print(client.models.list())'],
  },
  {
    name: 'k8s secret (base64 value)',
    text: L('apiVersion: v1', 'kind: Secret', 'data:', '  password: cGFzc3dvcmQxMjM0NTY=', '  username: YWRtaW4='),
    hide: ['cGFzc3dvcmQxMjM0NTY=', 'YWRtaW4='],
    keep: ['kind: Secret'],
  },
  {
    name: 'url query token',
    text: 'GET /api/report?format=csv&token=abc123def456ghi789&page=2',
    hide: ['abc123def456ghi789'],
    keep: ['/api/report?format=csv&', '&page=2'],
  },

  {
    name: 'cli: curl -u, --user/--password flags',
    text: L(
      'curl -u admin:s3cr3tPass https://api.internal.acme.io/v1/status',
      'wget --user=bob --password=hunter2xyz https://files.example.com/a.zip',
    ),
    hide: ['admin', 's3cr3tPass', 'bob', 'hunter2xyz'],
    keep: ['curl -u ', ' https://api.internal.acme.io/v1/status', 'wget --user=', ' --password=', ' https://files.example.com/a.zip'],
  },
  {
    name: 'nested json credentials and header-style keys',
    text: '{"credentials": {"user": "svc-deploy", "pass": "Tr0ub4dor&3"}, "headers": {"X-Api-Key": "3f8a9c1e7b2d4f60"}}',
    hide: ['svc-deploy', 'Tr0ub4dor&3', '3f8a9c1e7b2d4f60'],
    keep: ['"credentials": {', '"headers": {'],
  },

  // ───────────── contacts ─────────────
  {
    name: 'ru: business email with phones and email',
    text: 'Здравствуйте! Пишу по поводу договора. Мой телефон +7 (916) 123-45-67, запасной 8 495 765-43-21, почта i.petrov@acme-corp.ru. Жду ответа.',
    hide: ['+7 (916) 123-45-67', '8 495 765-43-21', 'i.petrov@acme-corp.ru'],
    keep: ['Здравствуйте! Пишу по поводу договора.', 'Жду ответа.'],
    has: ['[PHONE_1]', '[PHONE_2]', '[EMAIL_1]'],
  },
  {
    name: 'phones: compact ru and international',
    text: L('89161234567', '8-916-123-45-67', '+1 (415) 555-2671', '+44 20 7946 0958', '(495) 123-45-67'),
    hide: ['89161234567', '8-916-123-45-67', '415) 555-2671', '20 7946 0958', '(495) 123-45-67'],
  },
  {
    name: 'telegram handles',
    text: 'Пиши в тг @ivan_petrov_dev или https://t.me/ivan_petrov_dev, telegram: @anna_k',
    hide: ['@ivan_petrov_dev', 'anna_k'],
    keep: ['Пиши в тг', 'https://t.me/'],
  },
  {
    name: 'same email in different case gets one placeholder',
    text: 'Ivan@Acme.ru написал, а потом ivan@acme.ru ещё раз.',
    hide: ['Ivan@Acme.ru', 'ivan@acme.ru'],
    has: ['[EMAIL_1]'],
    notHas: ['[EMAIL_2]'],
  },
  {
    name: 'csv rows',
    text: L('name,email,phone', 'A,anna@firm.ru,+7 999 111-22-33', 'B,boris@firm.ru,+7 999 444-55-66'),
    hide: ['anna@firm.ru', 'boris@firm.ru', '+7 999 111-22-33', '+7 999 444-55-66'],
    keep: ['name,email,phone'],
  },
  {
    name: 'git config email',
    text: L('[user]', '  name = Deploy Bot', '  email = deploy-bot@company.io'),
    hide: ['deploy-bot@company.io'],
    keep: ['[user]'],
  },

  // ───────────── network ─────────────
  {
    name: 'nginx access log',
    text: '192.168.1.45 - - [24/Sep/2026:10:15:32 +0300] "GET /api/users?token=abc123def456ghi HTTP/1.1" 200 512',
    hide: ['192.168.1.45', 'abc123def456ghi'],
    keep: ['[24/Sep/2026:10:15:32 +0300]', '"GET /api/users?token=', '200 512'],
  },
  {
    name: 'stacktrace with ip and email',
    text: L(
      'java.net.ConnectException: Connection refused: 10.0.3.17:8080',
      '\tat com.acme.billing.Service.call(Service.java:42)',
      '\tat com.acme.billing.Main.main(Main.java:15)',
      'Caused by: user=ivan@acme-corp.ru',
    ),
    hide: ['10.0.3.17', 'ivan@acme-corp.ru'],
    keep: [':8080', '\tat com.acme.billing.Service.call(Service.java:42)'],
  },
  {
    name: 'mac + ipv6',
    text: L('eth0: aa:bb:cc:dd:ee:ff', 'inet6 2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'fe80::1ff:fe23:4567:890a'),
    hide: ['aa:bb:cc:dd:ee:ff', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'fe80::1ff:fe23:4567:890a'],
    keep: ['eth0:', 'inet6'],
  },
  {
    name: 'internal hostnames',
    text: 'ssh deploy@build-07.corp; curl http://grafana.internal:3000/dash; ping nas.lan',
    hide: ['build-07.corp', 'grafana.internal', 'nas.lan'],
    keep: ['ssh ', 'curl http://', ':3000/dash', 'ping '],
  },
  {
    name: 'ips: repeated values share placeholders, cidr keeps mask',
    text: L('from 10.1.1.5 to 10.1.1.9', 'retry 10.1.1.5 -> 10.1.1.9', 'again 10.1.1.5', 'subnet 10.0.0.0/24'),
    hide: ['10.1.1.5', '10.1.1.9', '10.0.0.0'],
    keep: ['/24'],
    has: ['[IP_1]', '[IP_2]', '[IP_3]'],
    notHas: ['[IP_4]'],
  },
  {
    name: 'emoji and surrogate pairs do not shift offsets',
    text: '🔑 ключ: ' + OPENAI + ' 🚀 почта 📧 x.y@corp-mail.ru 🎉',
    hide: [OPENAI, 'x.y@corp-mail.ru'],
    keep: ['🔑 ключ: ', ' 🚀 почта 📧 ', ' 🎉'],
  },

  // ───────────── dictionary / names / companies ─────────────
  {
    name: 'dict: person and company, russian cases',
    text: 'Иван Петров из Acme Corp просит доступ. Передай Ивану Петрову, что у Acme Corp всё готово; спросишь у Петрова?',
    dict: [
      { term: 'Иван Петров', type: 'PERSON' },
      { term: 'Петров', type: 'PERSON' },
      { term: 'Acme Corp', type: 'ORG' },
    ],
    hide: ['Иван Петров', 'Acme Corp', 'Ивану Петрову', 'Петрова'],
    keep: ['просит доступ. Передай ', 'всё готово; спросишь у '],
    has: ['[PERSON_1]', '[ORG_1]'],
  },
  {
    name: 'dict: all case forms of a surname collapse into one placeholder',
    text: 'Иванов подписал. Отправьте Иванову. Согласовано с Ивановым. Письмо от Ивановой. Про Иванове и Ивановых.',
    dict: [{ term: 'Иванов', type: 'PERSON' }],
    hide: ['Иванов', 'Иванову', 'Ивановым', 'Ивановой', 'Иванове', 'Ивановых'],
    has: ['[PERSON_1]'],
    notHas: ['[PERSON_2]'],
  },
  {
    name: 'dict: first name is not confused with surname',
    text: 'Иван позвонил Иванову, а Ивана не было.',
    dict: [{ term: 'Иван', type: 'PERSON' }],
    hide: ['Иван ', 'Ивана'],
    keep: ['Иванову'],
  },
  {
    name: 'dict: soft-sign and -ей / -ий names',
    text: 'Сергей, Сергея, Сергею, Сергеем; Юрий, Юрия, Юрием; Игорь, Игоря.',
    dict: [
      { term: 'Сергей', type: 'PERSON' },
      { term: 'Юрий', type: 'PERSON' },
      { term: 'Игорь', type: 'PERSON' },
    ],
    hide: ['Сергей', 'Сергея', 'Сергею', 'Сергеем', 'Юрий', 'Юрия', 'Юрием', 'Игорь', 'Игоря'],
    has: ['[PERSON_1]', '[PERSON_2]', '[PERSON_3]'],
    notHas: ['[PERSON_4]'],
  },
  {
    name: 'dict: adjectival surname',
    text: 'Достоевский, Достоевского, Достоевскому, Толстой, Толстого.',
    dict: [
      { term: 'Достоевский', type: 'PERSON' },
      { term: 'Толстой', type: 'PERSON' },
    ],
    hide: ['Достоевск', 'Толст'],
  },
  {
    name: 'dict: latin term, boundaries and case',
    text: 'Globex quarterly report: GLOBEX revenue grew; globex.com hosts it; Globexology is a word.',
    dict: [{ term: 'Globex', type: 'ORG' }],
    hide: ['Globex quarterly', 'GLOBEX revenue', 'globex.com'],
    keep: ['Globexology is a word.'],
  },
  {
    name: 'dict: quoted company names, longer term wins',
    text: 'ООО «Ромашка» и АО "Ромашка-Плюс" подписали договор.',
    dict: [
      { term: 'Ромашка', type: 'ORG' },
      { term: 'Ромашка-Плюс', type: 'ORG' },
    ],
    hide: ['Ромашка'],
    keep: ['ООО «', '» и АО "', '" подписали договор.'],
    has: ['[ORG_1]', '[ORG_2]'],
  },
  {
    name: 'dict: company in ru cases',
    text: 'Открыл счёт в Сбербанке, написал Сбербанку и ушёл из Сбербанка.',
    dict: [{ term: 'Сбербанк', type: 'ORG' }],
    hide: ['Сбербанк'],
    has: ['[ORG_1]'],
    notHas: ['[ORG_2]'],
  },
  {
    name: 'dict: term with regex metacharacters',
    text: 'Проект C++ (v2) и проект A.B* используют внутренний API.',
    dict: [
      { term: 'C++ (v2)', type: 'SECRET' },
      { term: 'A.B*', type: 'SECRET' },
    ],
    hide: ['C++ (v2)', 'A.B*'],
    keep: ['используют внутренний API.'],
  },

  // ───────────── name heuristics (no dictionary, no model) ─────────────
  {
    name: 'heuristic: legal form + quoted or bare name',
    text: 'Договор между ООО «Ромашка» и ПАО Сбербанк, а также АО "Северсталь-Плюс" и ЗАО «Вектор Про».',
    hide: ['Ромашка', 'Сбербанк', 'Северсталь-Плюс', 'Вектор Про'],
    keep: ['Договор между ООО «', '» и ПАО ', ', а также АО "', '" и ЗАО «', '».'],
    has: ['[ORG_1]', '[ORG_4]'],
  },
  {
    name: 'heuristic: "компания X" in cases',
    text: 'Пишу от компании Ланит. Мы работаем с фирмой Вектор и в организации Техносфера, а компания Сибирские Дали растёт.',
    hide: ['Ланит', 'Вектор', 'Техносфера', 'Сибирские Дали'],
    keep: ['Пишу от компании ', 'Мы работаем с фирмой ', ' и в организации ', ', а компания '],
  },
  {
    name: 'heuristic: surname with initials, both orders',
    text: 'Иванов И.И. подписал; согласовано с Петровой А. С.; передать К.Л. Романову и ИП Григорьев А.В.',
    hide: ['Иванов И.И.', 'Петровой А. С.', 'К.Л. Романову', 'Григорьев А.В.'],
    keep: [' подписал; согласовано с ', '; передать ', ' и ИП '],
  },
  {
    name: 'fp: company / initials words without proper names',
    text: 'В нашей компании работает много людей. Компания выросла. Фирма работает с 9 до 18. Т. е. так и есть, т.к. иначе нельзя.',
    noop: true,
  },

  // ───────────── realistic long prompts ─────────────
  {
    name: 'realistic: ru support ticket with everything',
    text: L(
      'Привет! Клиент Мария Соколова (m.sokolova@bigshop.ru, +7 (903) 555-11-22) не может войти в личный кабинет.',
      'Мы используем Keycloak на auth.bigshop.corp, логин: kc_admin, пароль: Adm1n!Pass#77.',
      'Токен сервисного аккаунта: ' + GH,
      'Ошибка в логах: 401 from 172.16.4.20, user=m.sokolova@bigshop.ru',
      'Помоги написать ответ клиенту.',
    ),
    dict: [
      { term: 'Мария Соколова', type: 'PERSON' },
      { term: 'BigShop', type: 'ORG' },
    ],
    hide: ['Мария Соколова', 'm.sokolova@bigshop.ru', '+7 (903) 555-11-22', 'auth.bigshop.corp', 'kc_admin', 'Adm1n!Pass#77', GH, '172.16.4.20'],
    keep: ['Привет! Клиент ', 'не может войти в личный кабинет.', 'Помоги написать ответ клиенту.', 'Мы используем Keycloak на '],
    has: ['[PERSON_1]', '[EMAIL_1]', '[PHONE_1]', '[IP_1]'],
    notHas: ['[EMAIL_2]'],
  },
  {
    name: 'realistic: markdown README with secrets in code fences',
    text: L(
      '## Setup',
      '',
      '```bash',
      `export STRIPE_SECRET_KEY=${STRIPE}`,
      'export DB_PASSWORD="letmein_2024"',
      'npm start',
      '```',
      '',
      'Contact: ops@startup.dev',
    ),
    hide: [STRIPE, 'letmein_2024', 'ops@startup.dev'],
    keep: ['## Setup', '```bash', 'npm start', '```', 'Contact: '],
  },
  {
    name: 'realistic: english mix with dict people',
    text: 'Hi team, Anna Weber (anna.weber@globex.io) from Initech asked about the outage on 10.9.8.7. Please reply to Anna and CC her manager.',
    dict: [
      { term: 'Anna Weber', type: 'PERSON' },
      { term: 'Anna', type: 'PERSON' },
      { term: 'Initech', type: 'ORG' },
    ],
    hide: ['Anna Weber', 'anna.weber@globex.io', 'Initech', '10.9.8.7', 'reply to Anna'],
    keep: ['Hi team, ', 'asked about the outage on ', 'and CC her manager.'],
  },

  // ───────────── edge cases ─────────────
  { name: 'empty string', text: '', noop: true },
  { name: 'whitespace only', text: '  \n\t  \n', noop: true },
  { name: 'plain prose without secrets', text: 'Расскажи, как работает сборщик мусора в Go, и чем он отличается от Java.', noop: true },
  { name: 'already masked text is left alone', text: 'Привет, [PERSON_1]! Твой ключ [API_KEY_1], почта [EMAIL_1].', noop: true },

  // ───────────── false positives (must stay untouched) ─────────────
  {
    name: 'fp: versions, hashes, uuid, digests',
    text: L(
      'Node 18.17.1, Python 3.11.4, nginx:1.25.3, version 1.2.3.4, v5.6.7.8',
      'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
      'uuid 550e8400-e29b-41d4-a716-446655440000',
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ),
    noop: true,
  },
  {
    name: 'fp: example and reserved emails',
    text: 'Пример: user@example.com, test@example.org, noreply@localhost, foo@example.net',
    noop: true,
  },
  {
    name: 'fp: loopback and well-known public ips',
    text: 'http://localhost:3000 127.0.0.1 0.0.0.0 255.255.255.255 8.8.8.8 1.1.1.1 ::1',
    noop: true,
  },
  {
    name: 'fp: plain numbers, dates and times',
    text: 'Order #1234567890, total 15000.50 RUB, date 2024-01-15 10:30:45, build 20240115.3, ratio 3:2:1, 12:34:56.',
    noop: true,
  },
  {
    name: 'fp: decorators, scoped packages, css at-rules',
    text: L("@Override", "import '@babel/core'", "npm i @types/node @angular/core", "@media (max-width: 600px) { }", "@app.route('/')", "@property"),
    noop: true,
  },
  {
    name: 'fp: prose about passwords',
    text: 'The password must contain 8 characters. Пароль должен содержать 8 символов. Забыли пароль? Reset your password here.',
    noop: true,
  },
  {
    name: 'fp: documentation phrases after "password:"',
    text: L('Пароль: не менее 8 символов', 'Password: required', 'Пароль: любой', 'Password: none', 'Логин: не указан'),
    noop: true,
  },
  {
    name: 'fp: code reading secrets from env / types / templates',
    text: L(
      'password = os.environ["DB_PASSWORD"]',
      'api_key = getpass()',
      'token: str',
      'password: string;',
      'const secret = process.env.SECRET',
      '"password": "${DB_PASSWORD}"',
      '"apiKey": null',
      '"token": "<your-token-here>"',
      '"secret": "********"',
      'password: {{ .Values.db.password }}',
      'token_type: bearer',
      'password_min_length: 8',
    ),
    noop: true,
  },
];
