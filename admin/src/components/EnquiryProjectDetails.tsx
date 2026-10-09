// Structured answers from booking form v2 (enquiries.project_details).
//
// The Worker stores English catalogue labels. The CRM shows them as stored in
// English and translates the known catalogue values for a Russian reader;
// anything the client typed (other placement, size, existing details) is shown
// exactly as written.

import type { Language } from '../lib/i18n';
import type { EnquiryProjectDetails as Details } from '../lib/types';

const RU: Record<string, string> = {
  Arm: 'Рука',
  Leg: 'Нога',
  'Chest & Ribs': 'Грудь и рёбра',
  Back: 'Спина',
  'Stomach & Sides': 'Живот и бока',
  'Neck & Head': 'Шея и голова',
  Hand: 'Кисть',
  Foot: 'Стопа',
  Other: 'Другое',
  Shoulder: 'Плечо',
  'Upper arm': 'Верх руки',
  'Inner bicep': 'Внутренняя сторона бицепса',
  Elbow: 'Локоть',
  Forearm: 'Предплечье',
  Wrist: 'Запястье',
  'Half sleeve': 'Полрукава',
  '3/4 sleeve': 'Рукав 3/4',
  'Full sleeve': 'Полный рукав',
  Thigh: 'Бедро',
  Knee: 'Колено',
  Calf: 'Икра',
  Shin: 'Голень',
  Ankle: 'Щиколотка',
  'Half leg sleeve': 'Полрукава на ноге',
  'Full leg sleeve': 'Полный рукав на ноге',
  Sternum: 'Грудина',
  'One side of chest': 'Одна сторона груди',
  Collarbone: 'Ключица',
  Ribs: 'Рёбра',
  'Full chest': 'Вся грудь',
  'Upper back': 'Верх спины',
  'Shoulder blade': 'Лопатка',
  Spine: 'Позвоночник',
  'Lower back': 'Поясница',
  'Full back': 'Вся спина',
  Stomach: 'Живот',
  Side: 'Бок',
  Hip: 'Тазовая кость',
  'Front of neck': 'Передняя часть шеи',
  'Side of neck': 'Боковая часть шеи',
  'Back of neck': 'Задняя часть шеи',
  'Behind the ear': 'За ухом',
  Head: 'Голова',
  'Back of hand': 'Тыльная сторона кисти',
  Fingers: 'Пальцы',
  'Side of hand': 'Ребро ладони',
  'Top of foot': 'Подъём стопы',
  'Side of foot': 'Боковая часть стопы',
  Toes: 'Пальцы ног',
  'New tattoo': 'Новая татуировка',
  Extension: 'Продолжение',
  'Cover-up': 'Перекрытие',
  Rework: 'Переработка',
  'Black & Grey realism': 'Чёрно-серый реализм',
  'Colour realism': 'Цветной реализм',
  'Not sure yet': 'Пока не решил(а)',
};

const COPY = {
  en: { areas: 'Body areas', styles: 'Style', size: 'Exact placement and size', existing: 'Existing tattoo', notGiven: '—' },
  ru: { areas: 'Зоны тела', styles: 'Стиль', size: 'Точное место и размер', existing: 'Существующая татуировка', notGiven: '—' },
} as const;

function label(value: string, language: Language): string {
  return language === 'ru' ? RU[value] ?? value : value;
}

export function isStructuredProjectDetails(value: unknown): value is Details {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as Details).areas)
    && Array.isArray((value as Details).styles)
  );
}

export function EnquiryProjectDetails({ details, language }: { details: Details; language: Language }) {
  const copy = COPY[language] ?? COPY.en;
  return (
    <dl className="definition" data-testid="enquiry-project-details">
      <dt>{copy.areas}</dt>
      <dd>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {details.areas.map((area) => {
            const where = area.placements.filter((placement) => placement !== 'Other').map((placement) => label(placement, language));
            if (area.otherPlacement) where.push(area.otherPlacement);
            return (
              <li key={area.region}>
                <strong>{label(area.region, language)}</strong>
                {where.length ? `: ${where.join(', ')}` : ''}
                {area.work.length ? ` — ${area.work.map((work) => label(work, language)).join(', ')}` : ''}
              </li>
            );
          })}
        </ul>
      </dd>
      <dt>{copy.styles}</dt>
      <dd>{details.styles.map((style) => label(style, language)).join(', ') || copy.notGiven}</dd>
      {details.sizeNotes ? (<><dt>{copy.size}</dt><dd>{details.sizeNotes}</dd></>) : null}
      {details.existingDetails ? (<><dt>{copy.existing}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{details.existingDetails}</dd></>) : null}
    </dl>
  );
}
