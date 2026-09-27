// One invoice: what it charges for, what has been paid, what was credited, and
// what is still owed.
//
// The screen never computes money. Every figure on it comes back from
// `get_invoice`, which derives it from the line items, the ledger and the
// credit notes; the forms only name a record and an amount to attempt. That is
// why a rejected payment leaves the screen showing the server's numbers rather
// than an optimistic guess.

import { useBlockingLoad } from '../lib/detail-loading';
import { useEffect, useMemo, useState } from 'react';
import { useAsync } from '../components/AsyncData';
import { DetailHeader } from '../components/DetailContext';
import { EmptyState, ErrorState, LoadingState, Section } from '../components/StateViews';
import { cancelLabelFor, confirmDialog } from '../lib/confirm-dialog';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
import { useLanguage, type Language } from '../lib/i18n';
import { invoiceStatusLabel, type InvoiceDocument } from '../lib/invoice-api';
import type { ProjectPaymentRequest } from '../lib/payment-api';
import { canAccess } from '../lib/permissions';
import { Link } from '../lib/router';
import { useApi, useSession } from '../lib/session';
import './InvoicesPage.css';

interface DetailData {
  document: InvoiceDocument;
  linkable: ProjectPaymentRequest[];
}

export function InvoiceDetailPage({ invoiceId }: { invoiceId: string }) {
  const api = useApi();
  const { profile, memberships } = useSession();
  const { language } = useLanguage();
  const copy = COPY[language];
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync<DetailData>(async () => {
    const document = await api.getInvoice(invoiceId);
    // Deposits already taken on this project, so one can be counted towards
    // the invoice instead of being re-entered as a new payment.
    const requests = await api
      .listProjectPaymentRequests(document.invoice.project_id)
      .catch(() => []);
    return { document, linkable: requests };
  }, [api, invoiceId]);

  useEffect(() => { setActionNotice(null); }, [invoiceId]);

  const blockingLoad = useBlockingLoad(loading, data != null, invoiceId);
  if (blockingLoad) return <LoadingState label={copy.loading} />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title={copy.notFound} hint={copy.notFoundHint} />;

  const { document } = data;
  const invoice = document.invoice;
  const scoped = memberships.filter((membership) => membership.artist_id === invoice.artist_id);
  const mayManage = canAccess(profile?.role, 'manageFinance', scoped);
  const isDraft = invoice.status === 'draft';
  const isVoid = invoice.status === 'void';
  const settled = invoice.amount_outstanding <= 0;

  async function run(action: () => Promise<unknown>, notice?: string) {
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await action();
      if (notice) setActionNotice(notice);
      reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DetailHeader to="/invoices" sectionLabel={copy.section} artistId={invoice.artist_id} />

      {actionError ? <p className="notice warn" role="alert">{actionError}</p> : null}
      {actionNotice ? <p className="notice" role="status">{actionNotice}</p> : null}

      <Section
        title={`${copy.invoice} ${invoice.invoice_number}`}
        action={
          <button type="button" onClick={() => window.print()}>{copy.print}</button>
        }
      >
        <div className="invoice-summary">
          <span className={invoice.is_overdue ? 'badge warn' : 'badge'}>
            {invoiceStatusLabel(invoice.status, invoice.is_overdue, language)}
          </span>
          <span className="badge">
            {copy.client}: <Link to={`/clients/${document.client.id}`}>{document.client.full_name}</Link>
          </span>
          <span className="badge">
            {copy.project}: <Link to={`/projects/${document.project.id}`}>{document.project.title}</Link>
          </span>
          <span className="badge">{copy.artist}: {document.artist.display_name}</span>
        </div>
        <dl className="invoice-figures">
          <div><dt>{copy.subtotal}</dt><dd>{formatMoney(invoice.subtotal, invoice.currency, language)}</dd></div>
          {invoice.discount_amount > 0 ? (
            <div><dt>{copy.discount}</dt><dd>−{formatMoney(invoice.discount_amount, invoice.currency, language)}</dd></div>
          ) : null}
          <div><dt>{copy.total}</dt><dd>{formatMoney(invoice.total, invoice.currency, language)}</dd></div>
          <div><dt>{copy.paid}</dt><dd>{formatMoney(invoice.amount_paid, invoice.currency, language)}</dd></div>
          <div><dt>{copy.credited}</dt><dd>{formatMoney(invoice.amount_credited, invoice.currency, language)}</dd></div>
          <div className="outstanding">
            <dt>{copy.outstanding}</dt>
            <dd>{formatMoney(invoice.amount_outstanding, invoice.currency, language)}</dd>
          </div>
        </dl>
        <p className="meta">
          {invoice.issue_date ? `${copy.issued}: ${formatDate(invoice.issue_date, language)}` : copy.notIssued}
          {invoice.due_date ? ` · ${copy.due}: ${formatDate(invoice.due_date, language)}` : ''}
        </p>
        {invoice.notes ? <p className="meta">{invoice.notes}</p> : null}
        {invoice.void_reason ? (
          <p className="notice warn" role="status">{copy.voidReason}: {invoice.void_reason}</p>
        ) : null}

        {mayManage && !isVoid ? (
          <div className="actions">
            {isDraft ? (
              <button
                type="button"
                disabled={busy || document.line_items.length === 0}
                onClick={() => { void run(() => api.issueInvoice(invoice.id), copy.issuedNotice); }}
              >
                {copy.issue}
              </button>
            ) : null}
          </div>
        ) : null}

        {mayManage && isDraft ? (
          <DraftDetailsForm
            language={language}
            busy={busy}
            currency={invoice.currency}
            dueDate={invoice.due_date}
            discountAmount={invoice.discount_amount}
            notes={invoice.notes}
            onSave={(input) => run(
              () => api.setInvoiceDetails({ invoiceId: invoice.id, ...input }),
              copy.detailsNotice
            )}
          />
        ) : null}

        {mayManage && !isVoid ? (
          <VoidInvoiceForm
            language={language}
            busy={busy}
            onVoid={(reason) => run(() => api.voidInvoice(invoice.id, reason), copy.voidedNotice)}
          />
        ) : null}
      </Section>

      <Section title={copy.lineItems}>
        {document.line_items.length === 0 ? (
          <EmptyState compact title={copy.noLines} />
        ) : (
          <table className="invoice-table">
            <thead>
              <tr>
                <th scope="col">{copy.description}</th>
                <th scope="col">{copy.quantity}</th>
                <th scope="col">{copy.unitPrice}</th>
                <th scope="col">{copy.lineTotal}</th>
                {mayManage && isDraft ? <th scope="col"><span className="visually-hidden">{copy.remove}</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {document.line_items.map((item) => (
                <tr key={item.id}>
                  <td>{item.description}</td>
                  <td>{item.quantity}</td>
                  <td>{formatMoney(item.unit_amount, invoice.currency, language)}</td>
                  <td>{formatMoney(item.line_total, invoice.currency, language)}</td>
                  {mayManage && isDraft ? (
                    <td>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        aria-label={`${copy.remove}: ${item.description}`}
                        onClick={() => { void run(() => api.removeInvoiceLineItem(item.id)); }}
                      >
                        {copy.remove}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {mayManage && isDraft ? (
          <AddLineItemForm
            language={language}
            busy={busy}
            onAdd={(input) => run(() => api.setInvoiceLineItem({ invoiceId: invoice.id, ...input }))}
          />
        ) : null}
        {mayManage && !isDraft && !isVoid ? (
          <p className="meta">{copy.linesLocked}</p>
        ) : null}
      </Section>

      <Section title={copy.payments}>
        {document.payments.length === 0 ? (
          <EmptyState compact title={copy.noPayments} />
        ) : (
          <div className="invoice-list">
            {document.payments.map((payment) => (
              <div className="row" key={payment.payment_transaction_id}>
                <div className="title">
                  {payment.direction === 'debit' ? '−' : ''}
                  {formatMoney(payment.amount, payment.currency, language)}
                </div>
                <div className="meta">
                  <span className="badge">{formatDateTime(payment.occurred_at, language)}</span>{' '}
                  <span className="badge">{paymentKindLabel(payment.purpose, language)}</span>{' '}
                  {payment.payment_method_code ? <span className="badge">{payment.payment_method_code}</span> : null}{' '}
                  {payment.external_reference ? <span className="badge">{payment.external_reference}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {mayManage && !isDraft && !isVoid && !settled ? (
          <RecordPaymentForm
            language={language}
            busy={busy}
            currency={invoice.currency}
            outstanding={invoice.amount_outstanding}
            onRecord={(input) => run(
              () => api.recordInvoicePayment({ invoiceId: invoice.id, ...input }),
              copy.paymentNotice
            )}
          />
        ) : null}

        {mayManage && !isDraft && !isVoid ? (
          <LinkDepositControl
            language={language}
            busy={busy}
            currency={invoice.currency}
            requests={data.linkable.filter(
              (request) => request.status !== 'cancelled' && request.status !== 'expired'
            )}
            onLink={(paymentRequestId) => run(
              () => api.attachPaymentRequestToInvoice({ paymentRequestId, invoiceId: invoice.id }),
              copy.linkedNotice
            )}
          />
        ) : null}
      </Section>

      <Section title={copy.creditNotes}>
        {document.credit_notes.length === 0 ? (
          <EmptyState compact title={copy.noCreditNotes} />
        ) : (
          <div className="invoice-list">
            {document.credit_notes.map((note) => (
              <div className="row" key={note.id}>
                <div className="title">{note.credit_note_number}</div>
                <div className="meta">
                  <span className="badge">−{formatMoney(note.amount, invoice.currency, language)}</span>{' '}
                  <span className="badge">{formatDateTime(note.issued_at, language)}</span>
                </div>
                <div className="meta">{note.reason}</div>
              </div>
            ))}
          </div>
        )}

        {mayManage && !isDraft && !isVoid && invoice.amount_outstanding > 0 ? (
          <CreditNoteForm
            language={language}
            busy={busy}
            currency={invoice.currency}
            maximum={invoice.amount_outstanding}
            onCreate={(input) => run(
              () => api.createCreditNote({ invoiceId: invoice.id, ...input }),
              copy.creditedNotice
            )}
          />
        ) : null}
      </Section>

      <InvoiceDocumentView document={document} language={language} />
    </>
  );
}

/**
 * The header fields a draft still owns. After issue the due date and the
 * discount stop moving, so this form is offered only while the invoice is a
 * draft rather than being shown and then refused.
 */
function DraftDetailsForm({
  language,
  busy,
  currency,
  dueDate,
  discountAmount,
  notes,
  onSave,
}: {
  language: Language;
  busy: boolean;
  currency: string;
  dueDate: string | null;
  discountAmount: number;
  notes: string | null;
  onSave: (input: { dueDate: string | null; discountAmount: number; notes: string | null }) => Promise<void>;
}) {
  const copy = COPY[language];
  const [due, setDue] = useState(dueDate ?? '');
  const [discount, setDiscount] = useState(String(discountAmount ?? 0));
  const [note, setNote] = useState(notes ?? '');
  const parsedDiscount = Number(discount);
  const valid = Number.isFinite(parsedDiscount) && parsedDiscount >= 0;

  return (
    <form
      className="form-grid"
      aria-label={copy.draftDetails}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onSave({
          dueDate: due || null,
          discountAmount: parsedDiscount,
          notes: note.trim() || null,
        });
      }}
    >
      <label>
        <span>{copy.dueDate}</span>
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
      </label>
      <label>
        <span>{copy.discountIn.replace('{currency}', currency)}</span>
        <input type="number" min="0" step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} />
      </label>
      <label>
        <span>{copy.notesField}</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !valid}>{copy.saveDetails}</button>
      </div>
      {!valid ? <p className="meta">{copy.discountInvalid}</p> : null}
    </form>
  );
}

/**
 * Voiding needs a reason and a second look. The reason is stored on the
 * invoice, so "why is this one void?" is answerable a year later without
 * reading the activity log.
 */
function VoidInvoiceForm({
  language,
  busy,
  onVoid,
}: {
  language: Language;
  busy: boolean;
  onVoid: (reason: string) => Promise<void>;
}) {
  const copy = COPY[language];
  const [reason, setReason] = useState('');
  const valid = reason.trim().length > 0;

  return (
    <form
      className="form-grid"
      aria-label={copy.void}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const approved = await confirmDialog({
          title: copy.voidTitle,
          message: copy.voidMessage,
          confirmLabel: copy.voidConfirm,
          cancelLabel: cancelLabelFor(language),
        });
        if (!approved) return;
        void onVoid(reason.trim()).then(() => setReason(''));
      }}
    >
      <label>
        <span>{copy.voidPrompt}</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="danger" disabled={busy || !valid}>{copy.void}</button>
      </div>
    </form>
  );
}

function AddLineItemForm({
  language,
  busy,
  onAdd,
}: {
  language: Language;
  busy: boolean;
  onAdd: (input: { description: string; quantity: number; unitAmount: number }) => Promise<void>;
}) {
  const copy = COPY[language];
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitAmount, setUnitAmount] = useState('');
  const numbers = useMemo(() => ({
    quantity: Number(quantity),
    unitAmount: Number(unitAmount),
  }), [quantity, unitAmount]);
  const valid = description.trim().length > 0
    && Number.isFinite(numbers.quantity) && numbers.quantity > 0
    && Number.isFinite(numbers.unitAmount) && numbers.unitAmount >= 0;

  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onAdd({
          description: description.trim(),
          quantity: numbers.quantity,
          unitAmount: numbers.unitAmount,
        }).then(() => { setDescription(''); setQuantity('1'); setUnitAmount(''); });
      }}
    >
      <label>
        <span>{copy.description}</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span>{copy.quantity}</span>
        <input type="number" min="0.01" step="0.01" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
      </label>
      <label>
        <span>{copy.unitPrice}</span>
        <input type="number" min="0" step="0.01" value={unitAmount} onChange={(event) => setUnitAmount(event.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !valid}>{copy.addLine}</button>
      </div>
    </form>
  );
}

function RecordPaymentForm({
  language,
  busy,
  currency,
  outstanding,
  onRecord,
}: {
  language: Language;
  busy: boolean;
  currency: string;
  outstanding: number;
  onRecord: (input: {
    amount: number;
    idempotencyKey: string;
    methodCode: string | null;
    externalReference: string | null;
  }) => Promise<void>;
}) {
  const copy = COPY[language];
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  // Minted once per attempt, so a double tap replays the same payment instead
  // of recording a second one.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= outstanding + 0.0001;

  return (
    <form
      className="form-grid"
      aria-label={copy.recordPayment}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void onRecord({
          amount: parsed,
          idempotencyKey: key,
          methodCode: method || null,
          externalReference: reference.trim() || null,
        }).then(() => { setAmount(''); setReference(''); setKey(crypto.randomUUID()); });
      }}
    >
      <label>
        <span>{copy.amount.replace('{max}', formatMoney(outstanding, currency, language))}</span>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label>
        <span>{copy.method}</span>
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="bank_transfer">{copy.methodBank}</option>
          <option value="card">{copy.methodCard}</option>
          <option value="cash">{copy.methodCash}</option>
        </select>
      </label>
      <label>
        <span>{copy.reference}</span>
        <input value={reference} onChange={(event) => setReference(event.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !valid}>{copy.recordPayment}</button>
      </div>
      {amount !== '' && !valid ? <p className="meta">{copy.amountInvalid}</p> : null}
    </form>
  );
}

function LinkDepositControl({
  language,
  busy,
  currency,
  requests,
  onLink,
}: {
  language: Language;
  busy: boolean;
  currency: string;
  requests: ProjectPaymentRequest[];
  onLink: (paymentRequestId: string) => Promise<void>;
}) {
  const copy = COPY[language];
  const [selected, setSelected] = useState('');
  if (requests.length === 0) return null;

  return (
    <form
      className="form-grid"
      aria-label={copy.linkDeposit}
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected) return;
        void onLink(selected).then(() => setSelected(''));
      }}
    >
      <label>
        <span>{copy.linkDeposit}</span>
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">{copy.choosePayment}</option>
          {requests.map((request) => (
            <option key={request.id} value={request.id}>
              {formatMoney(request.amount, currency, language)} · {paymentKindLabel(request.purpose, language)}
              {request.net_paid > 0 ? ` · ${copy.paid} ${formatMoney(request.net_paid, currency, language)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !selected}>{copy.link}</button>
      </div>
    </form>
  );
}

function CreditNoteForm({
  language,
  busy,
  currency,
  maximum,
  onCreate,
}: {
  language: Language;
  busy: boolean;
  currency: string;
  maximum: number;
  onCreate: (input: { amount: number; reason: string; idempotencyKey: string }) => Promise<void>;
}) {
  const copy = COPY[language];
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= maximum + 0.0001 && reason.trim().length > 0;

  return (
    <form
      className="form-grid"
      aria-label={copy.newCreditNote}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const approved = await confirmDialog({
          title: copy.creditTitle,
          message: copy.creditMessage.replace('{amount}', formatMoney(parsed, currency, language)),
          confirmLabel: copy.creditConfirm,
          cancelLabel: cancelLabelFor(language),
          tone: 'primary',
        });
        if (!approved) return;
        void onCreate({ amount: parsed, reason: reason.trim(), idempotencyKey: key })
          .then(() => { setAmount(''); setReason(''); setKey(crypto.randomUUID()); });
      }}
    >
      <label>
        <span>{copy.amount.replace('{max}', formatMoney(maximum, currency, language))}</span>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label>
        <span>{copy.reason}</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !valid}>{copy.newCreditNote}</button>
      </div>
      {amount !== '' && Number.isFinite(parsed) && parsed > maximum ? (
        <p className="meta">{copy.creditTooLarge}</p>
      ) : null}
    </form>
  );
}

/**
 * The printable document. It is part of the page rather than a second route,
 * so it is behind exactly the same authorisation as everything above it - there
 * is no separate URL that could be shared and no anonymous view of it.
 */
export function InvoiceDocumentView({
  document,
  language,
}: {
  document: InvoiceDocument;
  language: Language;
}) {
  const copy = COPY[language];
  const invoice = document.invoice;

  return (
    <article className="invoice-document" aria-label={copy.printable}>
      <header>
        <h2>{copy.invoice} {invoice.invoice_number}</h2>
        <p>{document.artist.legal_name ?? document.artist.display_name}</p>
      </header>
      <section>
        <p><strong>{copy.billedTo}:</strong> {document.client.full_name}</p>
        {document.client.email ? <p>{document.client.email}</p> : null}
        {document.client.phone ? <p>{document.client.phone}</p> : null}
        <p>
          {invoice.issue_date ? `${copy.issued}: ${formatDate(invoice.issue_date, language)}` : copy.notIssued}
          {invoice.due_date ? ` · ${copy.due}: ${formatDate(invoice.due_date, language)}` : ''}
        </p>
        <p>{copy.project}: {document.project.title}</p>
      </section>
      <table className="invoice-table">
        <thead>
          <tr>
            <th scope="col">{copy.description}</th>
            <th scope="col">{copy.quantity}</th>
            <th scope="col">{copy.unitPrice}</th>
            <th scope="col">{copy.lineTotal}</th>
          </tr>
        </thead>
        <tbody>
          {document.line_items.map((item) => (
            <tr key={item.id}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unit_amount, invoice.currency, language)}</td>
              <td>{formatMoney(item.line_total, invoice.currency, language)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row">{copy.total}</th><td colSpan={3}>{formatMoney(invoice.total, invoice.currency, language)}</td></tr>
          <tr><th scope="row">{copy.paid}</th><td colSpan={3}>{formatMoney(invoice.amount_paid, invoice.currency, language)}</td></tr>
          <tr><th scope="row">{copy.credited}</th><td colSpan={3}>{formatMoney(invoice.amount_credited, invoice.currency, language)}</td></tr>
          <tr><th scope="row">{copy.outstanding}</th><td colSpan={3}>{formatMoney(invoice.amount_outstanding, invoice.currency, language)}</td></tr>
        </tfoot>
      </table>
      {document.credit_notes.length > 0 ? (
        <section>
          <h3>{copy.creditNotes}</h3>
          <ul>
            {document.credit_notes.map((note) => (
              <li key={note.id}>
                {note.credit_note_number} · −{formatMoney(note.amount, invoice.currency, language)} · {note.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer><p>{copy.currencyNote.replace('{currency}', invoice.currency)}</p></footer>
    </article>
  );
}

function paymentKindLabel(purpose: string, language: Language): string {
  const labels: Record<string, { en: string; ru: string }> = {
    deposit: { en: 'Deposit', ru: 'Депозит' },
    session_balance: { en: 'Session balance', ru: 'Остаток за сеанс' },
    additional_payment: { en: 'Payment', ru: 'Платёж' },
    design_fee: { en: 'Design fee', ru: 'Оплата эскиза' },
    other: { en: 'Payment', ru: 'Платёж' },
  };
  return labels[purpose]?.[language] ?? purpose;
}

const COPY: Record<Language, Record<string, string>> = {
  en: {
    section: 'Invoices',
    invoice: 'Invoice',
    loading: 'Loading invoice…',
    notFound: 'Invoice not found',
    notFoundHint: 'It may belong to another artist.',
    failed: 'Could not do that.',
    print: 'Print',
    printable: 'Printable invoice',
    client: 'Client',
    project: 'Project',
    artist: 'Artist',
    subtotal: 'Subtotal',
    discount: 'Discount',
    total: 'Total',
    paid: 'Paid',
    credited: 'Credited',
    outstanding: 'Outstanding',
    issued: 'Issued',
    notIssued: 'Not issued yet',
    due: 'Due',
    voidReason: 'Voided',
    draftDetails: 'Invoice details',
    dueDate: 'Due date',
    discountIn: 'Discount in {currency}',
    notesField: 'Notes',
    saveDetails: 'Save details',
    detailsNotice: 'Invoice details saved.',
    discountInvalid: 'A discount cannot be negative.',
    issue: 'Issue invoice',
    issuedNotice: 'Invoice issued.',
    void: 'Void invoice',
    voidPrompt: 'Why is this invoice being voided?',
    voidTitle: 'Void this invoice?',
    voidMessage: 'A void invoice can never be edited, issued or paid again. Correct a figure with a credit note instead.',
    voidConfirm: 'Void it',
    voidedNotice: 'Invoice voided.',
    lineItems: 'Line items',
    noLines: 'Nothing charged for yet',
    linesLocked: 'An issued invoice keeps the figures the client was shown. Correct one with a credit note.',
    description: 'Description',
    quantity: 'Quantity',
    unitPrice: 'Unit price',
    lineTotal: 'Total',
    remove: 'Remove',
    addLine: 'Add line',
    payments: 'Payments',
    noPayments: 'Nothing received yet',
    recordPayment: 'Record payment',
    paymentNotice: 'Payment recorded.',
    amount: 'Amount (up to {max})',
    amountInvalid: 'Enter an amount between zero and the outstanding balance.',
    method: 'Method',
    methodBank: 'Bank transfer',
    methodCard: 'Card',
    methodCash: 'Cash',
    reference: 'Reference',
    linkDeposit: 'Count a deposit already taken',
    choosePayment: 'Choose a payment',
    link: 'Add to this invoice',
    linkedNotice: 'Payment added to this invoice.',
    creditNotes: 'Credit notes',
    noCreditNotes: 'No corrections',
    newCreditNote: 'Issue credit note',
    reason: 'Reason',
    creditTitle: 'Issue a credit note?',
    creditMessage: 'This reduces what the invoice asks for by {amount}. The invoice itself stays as it was issued, and the credit note cannot be edited afterwards.',
    creditConfirm: 'Issue it',
    creditedNotice: 'Credit note issued.',
    creditTooLarge: 'A credit note cannot be more than the invoice still asks for.',
    billedTo: 'Billed to',
    currencyNote: 'All amounts in {currency}.',
  },
  ru: {
    section: 'Счета',
    invoice: 'Счёт',
    loading: 'Загрузка счёта…',
    notFound: 'Счёт не найден',
    notFoundHint: 'Возможно, он относится к другому мастеру.',
    failed: 'Не удалось выполнить действие.',
    print: 'Печать',
    printable: 'Счёт для печати',
    client: 'Клиент',
    project: 'Проект',
    artist: 'Мастер',
    subtotal: 'Сумма позиций',
    discount: 'Скидка',
    total: 'Итого',
    paid: 'Оплачено',
    credited: 'Скорректировано',
    outstanding: 'К оплате',
    issued: 'Выставлен',
    notIssued: 'Ещё не выставлен',
    due: 'Срок оплаты',
    voidReason: 'Аннулирован',
    draftDetails: 'Реквизиты счёта',
    dueDate: 'Срок оплаты',
    discountIn: 'Скидка, {currency}',
    notesField: 'Примечание',
    saveDetails: 'Сохранить реквизиты',
    detailsNotice: 'Реквизиты счёта сохранены.',
    discountInvalid: 'Скидка не может быть отрицательной.',
    issue: 'Выставить счёт',
    issuedNotice: 'Счёт выставлен.',
    void: 'Аннулировать счёт',
    voidPrompt: 'Почему счёт аннулируется?',
    voidTitle: 'Аннулировать счёт?',
    voidMessage: 'Аннулированный счёт нельзя изменить, выставить заново или оплатить. Чтобы исправить сумму, используйте кредит-ноту.',
    voidConfirm: 'Аннулировать',
    voidedNotice: 'Счёт аннулирован.',
    lineItems: 'Позиции',
    noLines: 'Позиций пока нет',
    linesLocked: 'В выставленном счёте суммы остаются такими, какими их увидел клиент. Исправление — кредит-нота.',
    description: 'Описание',
    quantity: 'Количество',
    unitPrice: 'Цена за единицу',
    lineTotal: 'Сумма',
    remove: 'Удалить',
    addLine: 'Добавить позицию',
    payments: 'Платежи',
    noPayments: 'Поступлений пока нет',
    recordPayment: 'Записать платёж',
    paymentNotice: 'Платёж записан.',
    amount: 'Сумма (не больше {max})',
    amountInvalid: 'Введите сумму от нуля до остатка к оплате.',
    method: 'Способ',
    methodBank: 'Банковский перевод',
    methodCard: 'Карта',
    methodCash: 'Наличные',
    reference: 'Реквизит платежа',
    linkDeposit: 'Учесть уже внесённый депозит',
    choosePayment: 'Выберите платёж',
    link: 'Добавить к счёту',
    linkedNotice: 'Платёж добавлен к счёту.',
    creditNotes: 'Кредит-ноты',
    noCreditNotes: 'Корректировок нет',
    newCreditNote: 'Выписать кредит-ноту',
    reason: 'Причина',
    creditTitle: 'Выписать кредит-ноту?',
    creditMessage: 'Сумма к оплате уменьшится на {amount}. Сам счёт останется таким, каким был выставлен, а кредит-ноту потом нельзя изменить.',
    creditConfirm: 'Выписать',
    creditedNotice: 'Кредит-нота выписана.',
    creditTooLarge: 'Кредит-нота не может превышать остаток по счёту.',
    billedTo: 'Плательщик',
    currencyNote: 'Все суммы в {currency}.',
  },
};
