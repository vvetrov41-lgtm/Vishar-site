// Operator-facing failure messages, in both interface languages.
//
// Every read and write in this CRM funnels its failures through
// `friendlyMessage()`, which used to compose one English sentence:
// "Could not load clients. Please try again." Two things were wrong with
// that. It was English inside a Russian interface, and it did not answer the
// question the operator actually has, which is whether their work survived.
//
// The operation phrase is the key. That keeps every call site unchanged and
// still makes coverage a compile-time property: `ApiOperation` is the union
// of the keys below, so passing a phrase that has no Russian translation is a
// type error rather than a string that quietly leaks in English.
//
// `kind` is what lets the sentence say whether anything was saved. A failed
// read has nothing to lose and wants a reload; a failed write has to promise
// that the record was left alone, because otherwise the operator will try
// again and fear they have charged a deposit twice.

import type { Language } from './i18n';

type OperationKind = 'read' | 'write';

interface Operation {
  kind: OperationKind;
  /** Russian infinitive phrase, so it reads after "Не удалось …". */
  ru: string;
}

export const API_OPERATIONS = {
  'activate that account': { kind: 'write', ru: 'включить эту учётную запись' },
  'approve that email draft': { kind: 'write', ru: 'утвердить это письмо' },
  'assign that enquiry': { kind: 'write', ru: 'назначить исполнителя по заявке' },
  'attach that one-off Monzo payment link': { kind: 'write', ru: 'привязать эту одноразовую ссылку Monzo' },
  'block that time': { kind: 'write', ru: 'заблокировать это время' },
  'calculate the project deposit': { kind: 'read', ru: 'рассчитать депозит по проекту' },
  'cancel that payment request': { kind: 'write', ru: 'отменить этот запрос оплаты' },
  'change artist access': { kind: 'write', ru: 'изменить доступ к мастеру' },
  'change lifecycle rule timing': { kind: 'write', ru: 'изменить время срабатывания правила' },
  'change that appointment': { kind: 'write', ru: 'изменить эту запись' },
  'change that project status': { kind: 'write', ru: 'изменить статус проекта' },
  'change that role': { kind: 'write', ru: 'изменить роль сотрудника' },
  'change that session': { kind: 'write', ru: 'изменить этот сеанс' },
  'change that status': { kind: 'write', ru: 'изменить статус' },
  'change that time off': { kind: 'write', ru: 'изменить этот выходной' },
  'check appointment conflicts': { kind: 'read', ru: 'проверить накладки в расписании' },
  'check booking conflicts': { kind: 'read', ru: 'проверить пересечения записей' },
  'complete that follow-up': { kind: 'write', ru: 'отметить напоминание выполненным' },
  'confirm that Monzo payment': { kind: 'write', ru: 'подтвердить этот платёж Monzo' },
  'confirm that project deposit manually': { kind: 'write', ru: 'подтвердить депозит по проекту вручную' },
  'connect that WhatsApp conversation': { kind: 'write', ru: 'связать эту переписку WhatsApp с CRM' },
  'convert that enquiry': { kind: 'write', ru: 'превратить заявку в проект' },
  'create that follow-up': { kind: 'write', ru: 'создать напоминание' },
  'create that manual enquiry': { kind: 'write', ru: 'создать заявку вручную' },
  'create that project deposit request': { kind: 'write', ru: 'создать запрос депозита по проекту' },
  'deactivate that account': { kind: 'write', ru: 'отключить эту учётную запись' },
  'delete that client': { kind: 'write', ru: 'удалить этого клиента' },
  'delete that enquiry': { kind: 'write', ru: 'удалить эту заявку' },
  'finalize that reference image': { kind: 'write', ru: 'сохранить этот референс' },
  'ignore that Monzo payment': { kind: 'write', ru: 'скрыть этот платёж Monzo' },
  'list accessible artists': { kind: 'read', ru: 'загрузить список доступных мастеров' },
  'list colleagues': { kind: 'read', ru: 'загрузить список коллег' },
  'list staff': { kind: 'read', ru: 'загрузить список сотрудников' },
  'list team artist access': { kind: 'read', ru: 'загрузить доступы сотрудников к мастерам' },
  'load appointments': { kind: 'read', ru: 'загрузить записи' },
  'load artist availability': { kind: 'read', ru: 'загрузить занятость мастера' },
  'load calendar connections': { kind: 'read', ru: 'загрузить подключения календаря' },
  'load client names': { kind: 'read', ru: 'загрузить имена клиентов' },
  'load clients': { kind: 'read', ru: 'загрузить клиентов' },
  'load email conversations': { kind: 'read', ru: 'загрузить переписку по почте' },
  'load enquiries': { kind: 'read', ru: 'загрузить заявки' },
  'load failed integration jobs': { kind: 'read', ru: 'загрузить неудачные задачи интеграций' },
  'load follow-ups': { kind: 'read', ru: 'загрузить напоминания' },
  'load forms and websites': { kind: 'read', ru: 'загрузить формы и сайты' },
  'load integrations': { kind: 'read', ru: 'загрузить интеграции' },
  'load lifecycle automation health': { kind: 'read', ru: 'загрузить состояние автоматизаций' },
  'load lifecycle configuration history': { kind: 'read', ru: 'загрузить историю настроек автоматизаций' },
  'load lifecycle execution history': { kind: 'read', ru: 'загрузить историю запусков автоматизаций' },
  'load lifecycle preview sessions': { kind: 'read', ru: 'загрузить сеансы для предпросмотра' },
  'load lifecycle rules': { kind: 'read', ru: 'загрузить правила автоматизаций' },
  'load lifecycle template purposes': { kind: 'read', ru: 'загрузить назначения шаблонов' },
  'load lifecycle template variables': { kind: 'read', ru: 'загрузить переменные шаблонов' },
  'load lifecycle templates': { kind: 'read', ru: 'загрузить шаблоны автоматизаций' },
  'load Monzo deposit settings': { kind: 'read', ru: 'загрузить настройки депозитов Monzo' },
  'load Monzo reconciliation candidates': { kind: 'read', ru: 'загрузить поступившие платежи Monzo' },
  'load notes': { kind: 'read', ru: 'загрузить заметки' },
  'load notifications': { kind: 'read', ru: 'загрузить уведомления' },
  'load project finance': { kind: 'read', ru: 'загрузить финансы проекта' },
  'load project payment history': { kind: 'read', ru: 'загрузить историю платежей по проекту' },
  'load project payment requests': { kind: 'read', ru: 'загрузить запросы оплаты по проекту' },
  'load project status': { kind: 'read', ru: 'загрузить статус проекта' },
  'load projects': { kind: 'read', ru: 'загрузить проекты' },
  'load reference images': { kind: 'read', ru: 'загрузить референсы' },
  'load reusable payment links': { kind: 'read', ru: 'загрузить многоразовые ссылки на оплату' },
  'load schedule overrides': { kind: 'read', ru: 'загрузить исключения по дням' },
  'load scheduling preferences': { kind: 'read', ru: 'загрузить настройки расписания' },
  'load session finance': { kind: 'read', ru: 'загрузить финансы сеанса' },
  'load sessions': { kind: 'read', ru: 'загрузить сеансы' },
  'load that client': { kind: 'read', ru: 'загрузить карточку клиента' },
  'load that email': { kind: 'read', ru: 'загрузить это письмо' },
  'load that enquiry': { kind: 'read', ru: 'загрузить заявку' },
  'load that project': { kind: 'read', ru: 'загрузить проект' },
  'load the activity log': { kind: 'read', ru: 'загрузить журнал действий' },
  'load the allowed status changes': { kind: 'read', ru: 'загрузить доступные изменения статуса' },
  'load the artists in this organization': { kind: 'read', ru: 'загрузить мастеров этой организации' },
  'load the people in this organization': { kind: 'read', ru: 'загрузить сотрудников этой организации' },
  'load the people you can add': { kind: 'read', ru: 'загрузить, кого можно добавить' },
  'load the project deposit policy': { kind: 'read', ru: 'загрузить правило депозита по проектам' },
  'load the WhatsApp conversation': { kind: 'read', ru: 'загрузить переписку WhatsApp' },
  'load this organization’s automation defaults': { kind: 'read', ru: 'загрузить настройки автоматизаций организации' },
  'load what this artist still needs': { kind: 'read', ru: 'загрузить, чего ещё не хватает мастеру' },
  'load WhatsApp messages': { kind: 'read', ru: 'загрузить сообщения WhatsApp' },
  'load who can reach this artist': { kind: 'read', ru: 'загрузить, у кого есть доступ к мастеру' },
  'load workspaces': { kind: 'read', ru: 'загрузить организации' },
  'load your permissions': { kind: 'read', ru: 'загрузить ваши права' },
  'load your profile': { kind: 'read', ru: 'загрузить ваш профиль' },
  'match that Monzo payment': { kind: 'write', ru: 'сопоставить этот платёж Monzo' },
  'prepare that reference image': { kind: 'write', ru: 'подготовить загрузку референса' },
  'preview lifecycle rule': { kind: 'read', ru: 'показать предпросмотр правила' },
  'queue that WhatsApp message': { kind: 'write', ru: 'поставить сообщение WhatsApp в очередь' },
  'record that manual payment': { kind: 'write', ru: 'записать этот платёж вручную' },
  'remove that reference image': { kind: 'write', ru: 'удалить этот референс' },
  'remove that reusable payment link': { kind: 'write', ru: 'удалить многоразовую ссылку на оплату' },
  'remove that time off': { kind: 'write', ru: 'удалить этот выходной' },
  'request that deposit': { kind: 'write', ru: 'запросить депозит' },
  'request that multiple-session deposit': { kind: 'write', ru: 'запросить депозит за несколько сеансов' },
  'reschedule that appointment': { kind: 'write', ru: 'перенести эту запись' },
  'retry lifecycle execution': { kind: 'write', ru: 'повторить запуск автоматизации' },
  'save Monzo deposit settings': { kind: 'write', ru: 'сохранить настройки депозитов Monzo' },
  'save scheduling preferences': { kind: 'write', ru: 'сохранить настройки расписания' },
  'save that appointment note': { kind: 'write', ru: 'сохранить заметку к записи' },
  'save that note': { kind: 'write', ru: 'сохранить заметку' },
  'save that reusable payment link': { kind: 'write', ru: 'сохранить многоразовую ссылку на оплату' },
  'save that schedule override': { kind: 'write', ru: 'сохранить исключение для этого дня' },
  'save the project deposit override': { kind: 'write', ru: 'сохранить особый депозит по проекту' },
  'save the project deposit policy': { kind: 'write', ru: 'сохранить правило депозита по проектам' },
  'schedule that appointment': { kind: 'write', ru: 'создать эту запись' },
  'schedule that session': { kind: 'write', ru: 'назначить этот сеанс' },
  'update that client': { kind: 'write', ru: 'сохранить карточку клиента' },
  'update that enquiry': { kind: 'write', ru: 'сохранить заявку' },
  'update that project estimate': { kind: 'write', ru: 'сохранить оценку по проекту' },
  'update the deposit': { kind: 'write', ru: 'сохранить депозит' },
  'work out what that access would allow': { kind: 'read', ru: 'определить, что даст этот доступ' },
} as const satisfies Record<string, Operation>;

/**
 * Every operation the interface can report a failure for. Deliberately a union
 * of literal phrases rather than an opaque code: the call sites already read
 * as English, and a new one cannot be added without also being translated.
 */
export type ApiOperation = keyof typeof API_OPERATIONS;

/**
 * The sentence an operator sees when an operation fails.
 *
 * Three shapes, in the order they are checked:
 *
 *  - a permission denial, which is not a fault the operator can fix by
 *    retrying, so it names who can fix it;
 *  - a workflow guard from the database ("… is not allowed"), which is a
 *    deliberate, human-written explanation of why the CRM refused, and is
 *    passed through rather than replaced by something vaguer;
 *  - anything else, where the useful information is whether the work landed.
 *
 * Raw PostgREST codes, RPC names and HTTP statuses never reach this string.
 */
export function describeApiFailure(
  error: unknown,
  what: ApiOperation,
  language: Language,
): string {
  const operation = API_OPERATIONS[what];
  const code = readString(error, 'code');
  const message = readString(error, 'message');

  if (code === '42501' || code === 'PGRST301') {
    if (language === 'ru') {
      return operation.kind === 'write'
        ? `Недостаточно прав, чтобы ${operation.ru}. Изменения не сохранены — попросите владельца студии открыть доступ.`
        : `Недостаточно прав, чтобы ${operation.ru}. Попросите владельца студии открыть доступ.`;
    }
    return operation.kind === 'write'
      ? `You do not have permission to ${what}. Nothing was saved — ask the studio owner for access.`
      : `You do not have permission to ${what}. Ask the studio owner for access.`;
  }

  // A guard the database raised on purpose. It explains a workflow rule the
  // operator needs ("that status change is not allowed"), so replacing it with
  // a generic failure would lose the only useful part of the answer.
  if (message.includes('is not allowed')) return message;

  if (language === 'ru') {
    return operation.kind === 'write'
      ? `Не удалось ${operation.ru}. Изменения не сохранены — попробуйте ещё раз.`
      : `Не удалось ${operation.ru}. Данные не загружены — проверьте соединение и обновите страницу.`;
  }
  return operation.kind === 'write'
    ? `Could not ${what}. Nothing was saved — please try again.`
    : `Could not ${what}. Nothing was loaded — check your connection and reload.`;
}

function readString(error: unknown, key: 'code' | 'message'): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Failures each API module states in its own words, rather than through an
 * operation phrase: a malformed provider response, a misconfigured build, an
 * expired session, a file the CRM will not accept.
 *
 * The English sentence is the key, exactly as before, and `ApiMessage` is the
 * union of them - so an English-only string cannot be added to any of these
 * modules without a translation appearing here first.
 */
export const API_MESSAGES = {
  'A personal Telegram connection cannot name an artist.': 'Личное подключение Telegram не может быть привязано к мастеру.',
  'Choose an artist before connecting a shared Telegram group.': 'Выберите мастера, прежде чем подключать общую группу Telegram.',
  'Could not add that artist.': 'Не удалось добавить мастера. Изменения не сохранены — попробуйте ещё раз.',
  'Could not apply those defaults.': 'Не удалось применить настройки по умолчанию. Изменения не сохранены — попробуйте ещё раз.',
  'Could not change lifecycle rule state.': 'Не удалось изменить состояние правила. Изменения не сохранены — попробуйте ещё раз.',
  'Could not change lifecycle template state.': 'Не удалось изменить состояние шаблона. Изменения не сохранены — попробуйте ещё раз.',
  'Could not check your access.': 'Не удалось проверить ваш доступ. Данные не загружены — обновите страницу.',
  'Could not create a Telegram connection link.': 'Не удалось создать ссылку для подключения Telegram. Ничего не изменилось — попробуйте ещё раз.',
  'Could not create lifecycle rule.': 'Не удалось создать правило. Изменения не сохранены — попробуйте ещё раз.',
  'Could not create that client.': 'Не удалось создать карточку клиента. Изменения не сохранены — попробуйте ещё раз.',
  'Could not create that enquiry.': 'Не удалось создать заявку. Изменения не сохранены — попробуйте ещё раз.',
  'Could not create that form or website source.': 'Не удалось создать эту форму или сайт. Изменения не сохранены — попробуйте ещё раз.',
  'Could not create that organization.': 'Не удалось создать организацию. Изменения не сохранены — попробуйте ещё раз.',
  'Could not disconnect Telegram.': 'Не удалось отключить Telegram. Подключение осталось прежним — попробуйте ещё раз.',
  'Could not link that client.': 'Не удалось связать переписку с клиентом. Изменения не сохранены — попробуйте ещё раз.',
  'Could not load calendar connections. Please try again.': 'Не удалось загрузить подключения календаря. Данные не загружены — обновите страницу.',
  'Could not load Instagram connections.': 'Не удалось загрузить подключения Instagram. Данные не загружены — обновите страницу.',
  'Could not load Telegram connections.': 'Не удалось загрузить подключения Telegram. Данные не загружены — обновите страницу.',
  'Could not load Telegram connector information.': 'Не удалось загрузить сведения о коннекторе Telegram. Данные не загружены — обновите страницу.',
  'Could not load Telegram notification preference.': 'Не удалось загрузить настройку уведомлений Telegram. Данные не загружены — обновите страницу.',
  'Could not load that client\'s conversations.': 'Не удалось загрузить переписку этого клиента. Данные не загружены — обновите страницу.',
  'Could not load that conversation.': 'Не удалось загрузить переписку. Данные не загружены — обновите страницу.',
  'Could not load the inbox.': 'Не удалось загрузить сообщения. Данные не загружены — проверьте соединение и обновите страницу.',
  'Could not load those messages.': 'Не удалось загрузить сообщения переписки. Данные не загружены — обновите страницу.',
  'Could not load WhatsApp connections.': 'Не удалось загрузить подключения WhatsApp. Данные не загружены — обновите страницу.',
  'Could not open that artist.': 'Не удалось открыть карточку мастера. Данные не загружены — обновите страницу.',
  'Could not queue that reply.': 'Не удалось поставить ответ в очередь. Сообщение не отправлено — попробуйте ещё раз.',
  'Could not reach the staff invitation service.': 'Не удалось связаться со службой приглашений. Приглашение не отправлено — попробуйте ещё раз.',
  'Could not save lifecycle template draft.': 'Не удалось сохранить черновик шаблона. Изменения не сохранены — попробуйте ещё раз.',
  'Could not save that artist access.': 'Не удалось сохранить доступ к мастеру. Изменения не сохранены — попробуйте ещё раз.',
  'Could not save that artist.': 'Не удалось сохранить карточку мастера. Изменения не сохранены — попробуйте ещё раз.',
  'Could not save that organization access.': 'Не удалось сохранить доступ в организации. Изменения не сохранены — попробуйте ещё раз.',
  'Could not save that organization.': 'Не удалось сохранить организацию. Изменения не сохранены — попробуйте ещё раз.',
  'Could not seat that artist.': 'Не удалось выделить место мастеру. Изменения не сохранены — попробуйте ещё раз.',
  'Could not set that password. Choose a stronger password and try again.': 'Не удалось установить пароль. Пароль не изменён — выберите более надёжный и попробуйте ещё раз.',
  'Could not snooze that reminder.': 'Не удалось отложить напоминание. Изменения не сохранены — попробуйте ещё раз.',
  'Could not transfer ownership.': 'Не удалось передать владение. Изменения не сохранены — попробуйте ещё раз.',
  'Could not update Telegram notifications.': 'Не удалось изменить уведомления Telegram. Изменения не сохранены — попробуйте ещё раз.',
  'Could not update that conversation.': 'Не удалось обновить переписку. Изменения не сохранены — попробуйте ещё раз.',
  'Could not update that form or website source.': 'Не удалось сохранить эту форму или сайт. Изменения не сохранены — попробуйте ещё раз.',
  'Could not update that notification.': 'Не удалось обновить уведомление. Изменения не сохранены — попробуйте ещё раз.',
  'Could not update the Telegram bot username.': 'Не удалось изменить имя бота Telegram. Изменения не сохранены — попробуйте ещё раз.',
  'Enter a valid Telegram bot username.': 'Введите корректное имя бота Telegram.',
  'Meta Embedded Signup did not finish authorization.': 'Meta не завершила авторизацию. Подключение не создано — начните подключение заново.',
  'OAuth consent is not available in this CRM build.': 'Выдача доступа недоступна в этой сборке CRM.',
  'Only JPG, PNG or WebP reference images are allowed.': 'Допустимы только референсы в форматах JPG, PNG или WebP.',
  'Production WhatsApp onboarding is unavailable for this artist.': 'Подключение WhatsApp недоступно для этого мастера.',
  'Production WhatsApp provisioning is unavailable in this CRM environment.': 'Подключение WhatsApp недоступно в этой среде CRM.',
  'Reference images must be no larger than 4 MB.': 'Референс должен быть не больше 4 МБ.',
  'Staff invitations are not configured.': 'Приглашения сотрудников не настроены.',
  'Telegram linking is not configured correctly.': 'Подключение Telegram настроено неверно. Ничего не изменилось — проверьте настройки интеграции.',
  'Telegram linking returned an invalid response.': 'Telegram вернул некорректный ответ. Подключение не создано — попробуйте ещё раз.',
  'Telegram linking returned the wrong target.': 'Telegram вернул не тот адресат. Подключение не создано — попробуйте ещё раз.',
  'Telegram returned an invalid bot username.': 'Telegram вернул некорректное имя бота.',
  'That access was not saved.': 'Этот доступ не сохранён.',
  'That email address and password did not match.': 'Почта и пароль не совпали.',
  'The artist routing key is not valid for WhatsApp.': 'Ключ маршрутизации мастера не подходит для WhatsApp.',
  'The artist was not created.': 'Мастер не создан.',
  'The authorization decision could not be completed.': 'Не удалось завершить выдачу доступа. Доступ не выдан — попробуйте ещё раз.',
  'The authorization server did not identify the requesting GPT.': 'Сервер авторизации не опознал запрашивающий GPT. Доступ не выдан.',
  'The authorization server did not return a safe redirect.': 'Сервер авторизации вернул небезопасный адрес возврата. Доступ не выдан.',
  'The authorization server returned a mismatched request.': 'Сервер авторизации вернул несовпадающий запрос. Доступ не выдан.',
  'The booking source was not created.': 'Источник записи не создан.',
  'The CRM is not configured.': 'CRM не настроена.',
  'The Instagram connector is not configured in this build.': 'Коннектор Instagram не настроен в этой сборке.',
  'The lifecycle execution was not retried.': 'Запуск автоматизации не повторён.',
  'The lifecycle rule timing was not changed.': 'Время срабатывания правила не изменено.',
  'The lifecycle rule was not created.': 'Правило не создано.',
  'The lifecycle template draft was not saved.': 'Черновик шаблона не сохранён.',
  'The manual enquiry service returned an invalid response.': 'Служба ручных заявок вернула некорректный ответ. Заявка не создана — попробуйте ещё раз.',
  'The organization was not created.': 'Организация не создана.',
  'The seat was not created.': 'Место не создано.',
  'The staff invitation service returned an invalid response.': 'Служба приглашений вернула некорректный ответ. Приглашение не отправлено — попробуйте ещё раз.',
  'This authorization request is invalid or has expired.': 'Запрос на доступ недействителен или истёк. Начните заново.',
  'This client has an active project. Archive or close that project before deleting the client.': 'У этого клиента есть активный проект. Клиент не удалён — сначала закройте или заархивируйте проект.',
  'This enquiry has an active project. Archive or close that project before deleting the enquiry.': 'У этой заявки есть активный проект. Заявка не удалена — сначала закройте или заархивируйте проект.',
  'This GPT is not enabled for your CRM access.': 'Этот GPT не разрешён для вашего доступа к CRM.',
  'This GPT requested an unexpected OAuth scope.': 'Этот GPT запросил неожиданные права доступа. Доступ не выдан.',
  'VITE_INSTAGRAM_CONNECTOR_ORIGIN must be a permitted connector root URL.': 'Адрес коннектора Instagram настроен неверно. Обратитесь к администратору.',
  'WhatsApp integration controls are unavailable in this CRM environment.': 'Управление интеграцией WhatsApp недоступно в этой среде CRM.',
  'WhatsApp provisioning returned an invalid response.': 'Подключение WhatsApp вернуло некорректный ответ. Подключение не создано — попробуйте ещё раз.',
  'Your CRM session expired. Sign in again before connecting WhatsApp.': 'Сеанс CRM истёк. Войдите снова, прежде чем подключать WhatsApp.',
  'Your CRM session has expired. Sign in again.': 'Сеанс CRM истёк. Войдите снова.',
  'Your session has expired. Sign in again.': 'Сеанс истёк. Войдите снова.',
} as const satisfies Record<string, string>;

export type ApiMessage = keyof typeof API_MESSAGES;

/**
 * One of those sentences, in the language the interface is showing. The English
 * key is returned unchanged for an English operator.
 */
export function translateApiMessage(message: ApiMessage, language: Language): string {
  return language === 'ru' ? API_MESSAGES[message] : message;
}
