import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocumentMeta } from '../../types';
import styles from './HomePage.module.scss';

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function HomePage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch('/api/documents')
      .then((r) => r.json())
      .then((data: DocumentMeta[]) => setDocs(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleNewDocument = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const slugRes = await fetch('/api/slug');
      const { slug } = (await slugRes.json()) as { slug: string };

      await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: slug, slug }),
      });

      navigate(`/doc/${slug}`);
    } catch {
      setCreating(false);
    }
  }, [navigate, creating]);

  function handleDocKeyDown(
    e: React.KeyboardEvent<HTMLButtonElement>,
    slug: string,
  ) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/doc/${slug}`);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.logo}>Collab</h1>
          <p className={styles.tagline}>
            Real-time collaborative code editing — no login required.
          </p>
          <p className={styles.explainer}>
            Collab is a real-time collaborative editor for code — like Google
            Docs, but for code. Multiple people edit the same file live, with
            syntax highlighting and cursor presence. It syncs edits instantly;
            it does not execute code.
          </p>
        </header>

        <div className={styles.toolbar}>
          <h2 className={styles.sectionTitle}>Recent documents</h2>
          <button
            className={styles.newDocBtn}
            onClick={handleNewDocument}
            disabled={creating}
            aria-busy={creating}
            data-testid="new-doc-btn"
          >
            {creating ? 'Creating…' : '+ New Document'}
          </button>
        </div>

        {loading ? (
          <p className={styles.loading} role="status">
            Loading documents…
          </p>
        ) : docs.length === 0 ? (
          <div className={styles.empty}>
            <p>No documents yet.</p>
            <p>Click "+ New Document" to get started.</p>
          </div>
        ) : (
          <ul className={styles.list} data-testid="doc-list">
            {docs.map((doc) => (
              <li key={doc.id}>
                <button
                  className={styles.docItem}
                  onClick={() => navigate(`/doc/${doc.slug}`)}
                  onKeyDown={(e) => handleDocKeyDown(e, doc.slug)}
                  data-testid="doc-item"
                >
                  <div className={styles.docName}>{doc.title}</div>
                  <div className={styles.docMeta}>
                    /{doc.slug} &middot; {formatDate(doc.created_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
