import { useEffect, useRef, useState } from 'react';
import type { Language } from '../lib/i18n';

const MAX_REFERENCES = 3;
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const COPY = {
  en: {
    title: 'Reference images',
    add: 'Add references',
    hint: 'Optional. Up to 3 images, JPG/PNG/WebP, maximum 4 MB each.',
    limit: 'You can attach up to 3 reference images.',
    type: 'Only JPG, PNG or WebP reference images are allowed.',
    size: 'Each reference image must be 4 MB or smaller.',
    remove: 'Remove',
    open: 'Open selected reference at full size',
    selected: '{count} of 3 selected',
  },
  ru: {
    title: 'Референсы',
    add: 'Добавить референсы',
    hint: 'Необязательно. До 3 изображений, JPG/PNG/WebP, максимум 4 МБ каждое.',
    limit: 'Можно прикрепить не более 3 референсов.',
    type: 'Допустимы только изображения JPG, PNG или WebP.',
    size: 'Размер каждого референса должен быть не более 4 МБ.',
    remove: 'Удалить',
    open: 'Открыть выбранный референс в полном размере',
    selected: 'Выбрано {count} из 3',
  },
} as const;

function LocalReferencePreview({ file, onRemove, language, disabled }: {
  file: File;
  onRemove: () => void;
  language: Language;
  disabled: boolean;
}) {
  const copy = COPY[language];
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <div className="reference-thumb">
      <button
        type="button"
        className="reference-preview"
        disabled={!url || disabled}
        aria-label={`${copy.open}: ${file.name}`}
        title={`${copy.open}: ${file.name}`}
        onClick={() => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); }}
      >
        {url ? <img src={url} alt={file.name} /> : null}
      </button>
      <button
        type="button"
        className="reference-thumb-remove danger"
        disabled={disabled}
        onClick={onRemove}
      >
        {copy.remove}
      </button>
    </div>
  );
}

export function ManualReferencePicker({ files, onChange, language, disabled = false }: {
  files: readonly File[];
  onChange: (files: File[]) => void;
  language: Language;
  disabled?: boolean;
}) {
  const copy = COPY[language];
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function addFiles(selected: FileList | null) {
    if (!selected?.length) return;
    const incoming = Array.from(selected);
    if (files.length + incoming.length > MAX_REFERENCES) {
      setError(copy.limit);
      return;
    }
    if (incoming.some((file) => !ALLOWED_TYPES.has(file.type))) {
      setError(copy.type);
      return;
    }
    if (incoming.some((file) => file.size <= 0 || file.size > MAX_BYTES)) {
      setError(copy.size);
      return;
    }
    setError(null);
    onChange([...files, ...incoming]);
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 6 }}>{copy.title}</div>
      {files.length > 0 ? (
        <div className="thumbs" style={{ marginBottom: 10 }}>
          {files.map((file, index) => (
            <LocalReferencePreview
              key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
              file={file}
              language={language}
              disabled={disabled}
              onRemove={() => {
                setError(null);
                onChange(files.filter((_, itemIndex) => itemIndex !== index));
              }}
            />
          ))}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        aria-label={copy.title}
        onChange={(event) => {
          addFiles(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <div className="actions" style={{ marginTop: 0 }}>
        <button
          type="button"
          disabled={disabled || files.length >= MAX_REFERENCES}
          onClick={() => inputRef.current?.click()}
        >
          {copy.add}
        </button>
        {files.length > 0 ? <span className="badge">{copy.selected.replace('{count}', String(files.length))}</span> : null}
      </div>
      <p className="notice" style={{ marginTop: 8 }}>{copy.hint}</p>
      {error ? <p className="notice warn" role="alert">{error}</p> : null}
    </div>
  );
}
