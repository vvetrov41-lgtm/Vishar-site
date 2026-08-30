import type { Language } from './i18n';

export interface PaymentCopy {
  loadingPayments: string;
  chooseArtist: string;
  removeDestinationTitle: string;
  ignoreTitle: string;
  confirmPaymentTitle: string;
  noAssignedArtists: string;
  clientUnknown: string;
  connectionTitle: string;
  connectionDescription: (artist: string) => string;
  connectionAuthorized: (artist: string) => string;
  connectionConnected: (artist: string) => string;
  connectionDisconnected: (artist: string) => string;
  connectionDisabled: string;
  manageConnection: string;
  noConnectorRoute: string;
  connectionSecurity: string;
  depositsTitle: string;
  depositsDescription: (artist: string) => string;
  loadingSettings: string;
  reusablePaymentLink: string;
  enableArtist: string;
  depositPolicyNotice: string;
  saving: string;
  saveSettings: string;
  requestTitle: string;
  requestDescription: string;
  noEligibleAppointments: string;
  depositSuffix: string;
  createPersonalLink: string;
  createAmountLink: (amount: number) => string;
  queueDepositEmail: string;
  queueAmountEmail: (amount: number) => string;
  oneOffTitle: string;
  oneOffDescription: string;
  oneOffPaymentLink: string;
  saveOneOffLink: string;
  oneOffSaved: string;
  oneOffError: string;
  catalogueTitle: string;
  catalogueDescription: (artist: string) => string;
  catalogueSecurity: string;
  loadingCatalogue: string;
  noDestinations: string;
  destinationConfigured: string;
  destinationFingerprint: string;
  destinationIssuedRequests: (count: number) => string;
  addDestination: string;
  destinationAmount: string;
  destinationUrl: string;
  saveDestination: string;
  replaceDestination: string;
  removeDestination: string;
  removeDestinationPrompt: (amount: string) => string;
  destinationSaved: (amount: string) => string;
  destinationReplaced: (amount: string) => string;
  destinationArchived: (amount: string) => string;
  destinationInvalidAmount: string;
  destinationError: string;
  archiveError: string;
  policyTitle: string;
  policyDescription: (artist: string) => string;
  policyNotConfigured: string;
  policyCurrent: (summary: string) => string;
  policyMode: string;
  policyModeFixed: string;
  policyModePercentage: string;
  policyFixedAmount: string;
  policyPercentage: string;
  policyMinimum: string;
  policyRounding: string;
  savePolicy: string;
  policySaved: string;
  policyError: string;
  policyInvalid: string;
  reconciliationTitle: string;
  reconciliationDescription: string;
  reconciliationSecurity: string;
  loadingReconciliation: string;
  noCandidates: string;
  noSessionDate: string;
  outstanding: string;
  statusConfirmed: string;
  statusSuggested: string;
  statusMatched: string;
  statusIgnored: string;
  received: string;
  matched: string;
  suggested: string;
  confirmedLedger: string;
  ignoredNoChange: string;
  depositRequest: string;
  chooseEligibleRequest: string;
  suggestedSuffix: string;
  noExactOutstandingAmount: string;
  working: string;
  changeMatch: string;
  match: string;
  confirmPayment: string;
  ignore: string;
  viewOnly: string;
  requestCreated: string;
  emailQueued: string;
  personalPathReady: string;
  loadError: string;
  saveError: string;
  requestError: string;
  chooseRequestError: string;
  matchSuccess: string;
  matchError: string;
  ignorePrompt: (amount: string) => string;
  ignoreSuccess: string;
  ignoreError: string;
  confirmPrompt: (amount: string, client: string) => string;
  confirmSuccess: (status: string | null) => string;
  confirmError: string;
}

const EN: PaymentCopy = {
  loadingPayments: 'Loading payments…',
  chooseArtist: 'Choose one artist to manage payments.',
  removeDestinationTitle: 'Remove this payment destination?',
  ignoreTitle: 'Ignore this payment?',
  confirmPaymentTitle: 'Confirm this payment?',
  noAssignedArtists: 'This account is not assigned to any artist yet. Ask the owner for access.',
  clientUnknown: 'Client not available',
  connectionTitle: 'Monzo account connection',
  connectionDescription: (artist) => `${artist}: protected bank-account connection for payment reconciliation.`,
  connectionAuthorized: (artist) => `${artist}’s Monzo login is authorised. If Monzo asks for approval in the app, approve it there, then open Manage Monzo connection to select the receiving account.`,
  connectionConnected: (artist) => `${artist}’s Monzo account connection is active.`,
  connectionDisconnected: (artist) => `${artist}’s Monzo account connection is disconnected.`,
  connectionDisabled: 'Monzo account connection is disabled in this environment. Existing deposit settings remain unchanged.',
  manageConnection: 'Manage Monzo connection',
  noConnectorRoute: 'This artist does not have a Monzo connector route.',
  connectionSecurity: 'Connection opens as top-level navigation through the Access-protected Monzo connector. The CRM browser never receives Monzo access tokens, refresh tokens, webhook keys or bank account IDs.',
  depositsTitle: 'Deposits',
  depositsDescription: (artist) => `${artist}: duration-based Monzo Easy Bank Transfer deposits.`,
  loadingSettings: 'Loading payment settings…',
  reusablePaymentLink: 'Reusable Monzo payment link',
  enableArtist: 'Enable for this artist',
  depositPolicyNotice: 'Session deposits: up to 1 hour £50, up to 3 hours £100, up to 5 hours £150, over 5 hours / full day £250. This is a separate legacy session-deposit rule, not the project deposit amount. The server calculates it from the appointment duration.',
  saving: 'Saving…',
  saveSettings: 'Save settings',
  requestTitle: 'Create a new deposit for an individual session',
  requestDescription: 'This creates a NEW session deposit from the appointment duration. For example, a 7-hour session creates a £250 request. Do not use this to match money that has already arrived. Use “Already received money? Reconcile Monzo payment” below for an incoming transfer.',
  noEligibleAppointments: 'No eligible future tattoo appointments.',
  depositSuffix: 'session deposit',
  createPersonalLink: 'Create new session deposit link',
  createAmountLink: (amount) => `Create new £${amount} session deposit`,
  queueDepositEmail: 'Queue new session deposit email',
  queueAmountEmail: (amount) => `Queue new £${amount} session deposit email`,
  oneOffTitle: 'One-off Monzo link for this request',
  oneOffDescription: 'Use this only when the calculated amount has no reusable Monzo destination. It applies to this request only and never replaces an existing reusable link.',
  oneOffPaymentLink: 'One-off Monzo payment link',
  saveOneOffLink: 'Save one-off link',
  oneOffSaved: 'One-off link saved for this payment request. It did not change the amount or mark anything paid.',
  oneOffError: 'Could not attach that one-off Monzo link.',
  catalogueTitle: 'Reusable payment links',
  catalogueDescription: (artist) => `${artist}: one reusable Monzo link per exact amount. Any positive amount is allowed.`,
  catalogueSecurity: 'A reusable link is looked up by artist, amount and currency only. It carries no hours, session length, session count, project or client. Replacing or removing a link only affects requests created afterwards: a request already sent to a client keeps the destination it was issued with.',
  loadingCatalogue: 'Loading reusable payment links…',
  noDestinations: 'No reusable payment links yet.',
  destinationConfigured: 'Configured',
  destinationFingerprint: 'fingerprint',
  destinationIssuedRequests: (count) => `${count} issued request${count === 1 ? '' : 's'}`,
  addDestination: 'Add payment link',
  destinationAmount: 'Amount',
  destinationUrl: 'Monzo URL',
  saveDestination: 'Save',
  replaceDestination: 'Replace',
  removeDestination: 'Remove',
  removeDestinationPrompt: (amount) => `Remove the reusable ${amount} link from future use? Requests already sent to clients keep working.`,
  destinationSaved: (amount) => `Reusable ${amount} link saved. No payment request was created or repriced.`,
  destinationReplaced: (amount) => `Reusable ${amount} link replaced. Requests already issued keep their original destination.`,
  destinationArchived: (amount) => `Reusable ${amount} link removed from future use. Requests already issued keep working.`,
  destinationInvalidAmount: 'Enter a positive amount.',
  destinationError: 'Could not save that reusable payment link.',
  archiveError: 'Could not remove that reusable payment link.',
  policyTitle: 'Project deposit policy',
  policyDescription: (artist) => `${artist}: how a project deposit is calculated from the project estimate.`,
  policyNotConfigured: 'No project deposit policy yet. Projects cannot request a project deposit until one exists.',
  policyCurrent: (summary) => `Current policy: ${summary}`,
  policyMode: 'Deposit rule',
  policyModeFixed: 'Fixed amount per project',
  policyModePercentage: 'Percentage of project estimate',
  policyFixedAmount: 'Fixed deposit amount',
  policyPercentage: 'Percentage of estimate',
  policyMinimum: 'Minimum deposit (optional)',
  policyRounding: 'Round up to a multiple of',
  savePolicy: 'Save deposit policy',
  policySaved: 'Project deposit policy saved as a new version. Payment requests already issued keep the version they were priced with.',
  policyError: 'Could not save the project deposit policy.',
  policyInvalid: 'Enter a valid amount or percentage for the chosen rule.',
  reconciliationTitle: 'Already received money? Reconcile Monzo payment',
  reconciliationDescription: 'Use this for a bank transfer that has already arrived. Match it to the correct existing deposit request. Do not create a new session deposit just to make the amounts line up.',
  reconciliationSecurity: 'A Monzo webhook is only a hint. The server re-fetches the transaction from Monzo before it can appear here. Match does not mark anything paid. Confirm payment is a separate human action.',
  loadingReconciliation: 'Loading Monzo reconciliation…',
  noCandidates: 'No Monzo reconciliation candidates.',
  noSessionDate: 'No session date',
  outstanding: 'outstanding',
  statusConfirmed: 'Confirmed',
  statusSuggested: 'Suggested match',
  statusMatched: 'Matched',
  statusIgnored: 'Ignored',
  received: 'Received',
  matched: 'Matched',
  suggested: 'Suggested',
  confirmedLedger: 'Confirmed in the immutable payment ledger.',
  ignoredNoChange: 'Ignored. No payment status was changed.',
  depositRequest: 'Deposit request',
  chooseEligibleRequest: 'Choose an eligible deposit request',
  suggestedSuffix: 'suggested',
  noExactOutstandingAmount: 'No eligible deposit request has this exact outstanding amount.',
  working: 'Working…',
  changeMatch: 'Change match',
  match: 'Match',
  confirmPayment: 'Confirm payment',
  ignore: 'Ignore',
  viewOnly: 'View only. Finance management permission is required to match, confirm or ignore.',
  requestCreated: 'Deposit request created',
  emailQueued: 'Email is queued, but it will not send until an email provider is deliberately connected.',
  personalPathReady: 'The personal path is ready to send. Opening it redirects the client to this artist payment destination for the exact requested amount; opening it never marks the deposit paid.',
  loadError: 'Could not load payment settings.',
  saveError: 'Could not save payment settings.',
  requestError: 'Could not create the deposit request.',
  chooseRequestError: 'Choose an eligible deposit request first.',
  matchSuccess: 'Payment matched. Nothing has been marked paid yet. Confirm payment separately after checking the match.',
  matchError: 'Could not match that payment.',
  ignorePrompt: (amount) => `Ignore this ${amount} Monzo payment candidate? No payment status will change.`,
  ignoreSuccess: 'Payment candidate ignored. No ledger or payment status was changed.',
  ignoreError: 'Could not ignore that payment.',
  confirmPrompt: (amount, client) => `Confirm ${amount} as received for ${client}? This writes an immutable payment ledger entry and may mark the deposit paid.`,
  confirmSuccess: (status) => `Payment confirmed${status ? ` · request is now ${status}` : ''}.`,
  confirmError: 'Could not confirm that payment.',
};

const RU: PaymentCopy = {
  loadingPayments: 'Загружаем платежи…',
  chooseArtist: 'Выберите одного мастера для управления платежами.',
  removeDestinationTitle: 'Удалить этот реквизит для оплаты?',
  ignoreTitle: 'Игнорировать этот платёж?',
  confirmPaymentTitle: 'Подтвердить платёж?',
  noAssignedArtists: 'У этой учётной записи пока нет доступа ни к одному мастеру. Попросите владельца выдать доступ.',
  clientUnknown: 'Клиент недоступен',
  connectionTitle: 'Подключение Monzo',
  connectionDescription: (artist) => `${artist}: защищённое подключение банковского счёта для сверки платежей.`,
  connectionAuthorized: (artist) => `Вход в Monzo для ${artist} подтверждён. Если Monzo просит подтвердить доступ в приложении, подтвердите его там, затем снова откройте управление подключением Monzo и выберите счёт для приёма платежей.`,
  connectionConnected: (artist) => `Подключение счёта Monzo для ${artist} активно.`,
  connectionDisconnected: (artist) => `Подключение счёта Monzo для ${artist} отключено.`,
  connectionDisabled: 'Подключение Monzo отключено в этой среде. Текущие настройки депозитов не изменены.',
  manageConnection: 'Управление подключением Monzo',
  noConnectorRoute: 'Для этого мастера не настроен маршрут коннектора Monzo.',
  connectionSecurity: 'Подключение открывается отдельной страницей через защищённый Access коннектор Monzo. Браузер CRM никогда не получает токены доступа или обновления Monzo, ключ webhook или ID банковского счёта.',
  depositsTitle: 'Депозиты',
  depositsDescription: (artist) => `${artist}: депозиты отдельных сеансов через Monzo Easy Bank Transfer.`,
  loadingSettings: 'Загружаем настройки платежей…',
  reusablePaymentLink: 'Многоразовая ссылка Monzo для оплаты',
  enableArtist: 'Включить для этого мастера',
  depositPolicyNotice: 'Депозиты отдельных сеансов: до 1 часа £50, до 3 часов £100, до 5 часов £150, более 5 часов / полный день £250. Это отдельное старое правило для сеанса, а не сумма депозита проекта. Сервер рассчитывает её по длительности записи.',
  saving: 'Сохраняем…',
  saveSettings: 'Сохранить настройки',
  requestTitle: 'Создать новый депозит для отдельного сеанса',
  requestDescription: 'Этот блок создаёт НОВЫЙ депозит по длительности сеанса. Например, для 7-часового сеанса CRM создаст запрос на £250. Не используйте этот блок, если деньги уже пришли. Для полученного перевода используйте «Деньги уже пришли? Сопоставить платёж Monzo» ниже.',
  noEligibleAppointments: 'Нет подходящих будущих тату-сеансов.',
  depositSuffix: 'депозит сеанса',
  createPersonalLink: 'Создать новый депозит сеанса',
  createAmountLink: (amount) => `Создать новый депозит сеанса на £${amount}`,
  queueDepositEmail: 'Отправить новый депозит сеанса',
  queueAmountEmail: (amount) => `Отправить новый депозит сеанса на £${amount}`,
  oneOffTitle: 'Одноразовая ссылка Monzo для этого запроса',
  oneOffDescription: 'Используйте это поле только если для рассчитанной суммы нет многоразовой ссылки Monzo. Ссылка привязывается только к этому запросу и никогда не заменяет существующую многоразовую ссылку.',
  oneOffPaymentLink: 'Одноразовая ссылка Monzo для оплаты',
  saveOneOffLink: 'Сохранить одноразовую ссылку',
  oneOffSaved: 'Одноразовая ссылка сохранена для этого запроса. Сумма не изменилась, и платёж не был отмечен оплаченным.',
  oneOffError: 'Не удалось привязать эту одноразовую ссылку Monzo.',
  catalogueTitle: 'Многоразовые ссылки для оплаты',
  catalogueDescription: (artist) => `${artist}: одна многоразовая ссылка Monzo на каждую точную сумму. Допустима любая положительная сумма.`,
  catalogueSecurity: 'Многоразовая ссылка ищется только по мастеру, сумме и валюте. Она не связана с часами, длительностью сеанса, количеством сеансов, проектом или клиентом. Замена или удаление ссылки влияет только на запросы, созданные позже: уже отправленный клиенту запрос сохраняет своё платёжное назначение.',
  loadingCatalogue: 'Загружаем многоразовые ссылки…',
  noDestinations: 'Многоразовых ссылок пока нет.',
  destinationConfigured: 'Настроена',
  destinationFingerprint: 'отпечаток',
  destinationIssuedRequests: (count) => `запросов создано: ${count}`,
  addDestination: 'Добавить ссылку',
  destinationAmount: 'Сумма',
  destinationUrl: 'Ссылка Monzo',
  saveDestination: 'Сохранить',
  replaceDestination: 'Заменить',
  removeDestination: 'Удалить',
  removeDestinationPrompt: (amount) => `Убрать многоразовую ссылку на ${amount} из дальнейшего использования? Уже отправленные клиентам запросы продолжат работать.`,
  destinationSaved: (amount) => `Многоразовая ссылка на ${amount} сохранена. Платёжный запрос не создан и не пересчитан.`,
  destinationReplaced: (amount) => `Многоразовая ссылка на ${amount} заменена. Уже созданные запросы сохраняют прежнее назначение.`,
  destinationArchived: (amount) => `Многоразовая ссылка на ${amount} убрана из дальнейшего использования. Уже созданные запросы продолжают работать.`,
  destinationInvalidAmount: 'Введите положительную сумму.',
  destinationError: 'Не удалось сохранить многоразовую ссылку.',
  archiveError: 'Не удалось удалить многоразовую ссылку.',
  policyTitle: 'Правило депозита проекта',
  policyDescription: (artist) => `${artist}: как депозит проекта рассчитывается от сметы проекта.`,
  policyNotConfigured: 'Правило депозита проекта пока не настроено. Пока его нет, депозит по проекту запросить нельзя.',
  policyCurrent: (summary) => `Текущее правило: ${summary}`,
  policyMode: 'Способ расчёта',
  policyModeFixed: 'Фиксированная сумма на проект',
  policyModePercentage: 'Процент от сметы проекта',
  policyFixedAmount: 'Фиксированная сумма депозита',
  policyPercentage: 'Процент от сметы',
  policyMinimum: 'Минимальный депозит (необязательно)',
  policyRounding: 'Округлять вверх до кратного',
  savePolicy: 'Сохранить правило депозита',
  policySaved: 'Правило депозита проекта сохранено как новая версия. Уже созданные запросы сохраняют версию, по которой были рассчитаны.',
  policyError: 'Не удалось сохранить правило депозита проекта.',
  policyInvalid: 'Введите корректную сумму или процент для выбранного способа расчёта.',
  reconciliationTitle: 'Деньги уже пришли? Сопоставить платёж Monzo',
  reconciliationDescription: 'Используйте этот блок для уже полученного банковского перевода. Сопоставьте его с правильным существующим запросом депозита. Не создавайте новый депозит сеанса только ради совпадения суммы.',
  reconciliationSecurity: 'Webhook Monzo служит только сигналом. Перед появлением платежа здесь сервер повторно получает транзакцию из Monzo. Сопоставление само по себе ничего не отмечает оплаченным. Подтверждение платежа выполняется отдельным действием.',
  loadingReconciliation: 'Загружаем платежи Monzo для сверки…',
  noCandidates: 'Нет платежей Monzo для сверки.',
  noSessionDate: 'Дата сеанса не указана',
  outstanding: 'осталось оплатить',
  statusConfirmed: 'Подтверждён',
  statusSuggested: 'Предложено совпадение',
  statusMatched: 'Сопоставлен',
  statusIgnored: 'Игнорирован',
  received: 'Получен',
  matched: 'Сопоставлено',
  suggested: 'Предлагается',
  confirmedLedger: 'Платёж подтверждён в неизменяемом платёжном журнале.',
  ignoredNoChange: 'Платёж проигнорирован. Статус оплаты не изменён.',
  depositRequest: 'Запрос депозита',
  chooseEligibleRequest: 'Выберите подходящий запрос депозита',
  suggestedSuffix: 'рекомендуется',
  noExactOutstandingAmount: 'Нет подходящего запроса депозита с точно такой же неоплаченной суммой.',
  working: 'Выполняем…',
  changeMatch: 'Изменить сопоставление',
  match: 'Сопоставить',
  confirmPayment: 'Подтвердить платёж',
  ignore: 'Игнорировать',
  viewOnly: 'Только просмотр. Для сопоставления, подтверждения или игнорирования нужны права управления финансами.',
  requestCreated: 'Запрос депозита создан',
  emailQueued: 'Письмо поставлено в очередь, но оно не будет отправлено, пока почтовый провайдер не будет отдельно подключён.',
  personalPathReady: 'Персональный путь готов к отправке. При открытии клиент перенаправляется на платёжное назначение этого мастера для точной запрошенной суммы; само открытие никогда не отмечает депозит оплаченным.',
  loadError: 'Не удалось загрузить настройки платежей.',
  saveError: 'Не удалось сохранить настройки платежей.',
  requestError: 'Не удалось создать запрос депозита.',
  chooseRequestError: 'Сначала выберите подходящий запрос депозита.',
  matchSuccess: 'Платёж сопоставлен. Ничего ещё не отмечено оплаченным. После проверки отдельно подтвердите платёж.',
  matchError: 'Не удалось сопоставить этот платёж.',
  ignorePrompt: (amount) => `Игнорировать этот платёж Monzo на ${amount}? Статус оплаты не изменится.`,
  ignoreSuccess: 'Платёж проигнорирован. Платёжный журнал и статус оплаты не изменены.',
  ignoreError: 'Не удалось проигнорировать платёж.',
  confirmPrompt: (amount, client) => `Подтвердить получение ${amount} от клиента ${client}? Будет создана неизменяемая запись в платёжном журнале, и депозит может перейти в статус оплаченного.`,
  confirmSuccess: (status) => `Платёж подтверждён${status ? ` · новый статус запроса: ${status}` : ''}.`,
  confirmError: 'Не удалось подтвердить платёж.',
};

export function paymentCopy(language: Language): PaymentCopy {
  return language === 'ru' ? RU : EN;
}
