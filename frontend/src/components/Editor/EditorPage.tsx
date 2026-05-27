import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { JoinModal } from './JoinModal';
import { Toolbar } from './Toolbar';
import { PresenceSidebar } from './PresenceSidebar';
import { useCollabEditor } from '../../hooks/useCollabEditor';
import type { UserInfo } from '../../types';
import styles from './EditorPage.module.scss';

function getStoredPrefs(): { displayName: string; color: string } | null {
  try {
    const raw = localStorage.getItem('collab:userPrefs');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getOrCreateUserId(): string {
  let id = localStorage.getItem('collab:userId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('collab:userId', id);
  }
  return id;
}

export function EditorPage() {
  const { docId } = useParams<{ docId: string }>();
  const slug = docId ?? '';

  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [docTitle, setDocTitle] = useState(slug);

  // Check for returning user on mount
  useEffect(() => {
    const prefs = getStoredPrefs();
    const joinedKey = `collab:doc:${slug}:joined`;
    if (prefs && localStorage.getItem(joinedKey) === 'true') {
      setUserInfo({
        userId: getOrCreateUserId(),
        displayName: prefs.displayName,
        color: prefs.color,
      });
    } else {
      setShowJoinModal(true);
    }
  }, [slug]);

  // Fetch document title
  useEffect(() => {
    fetch(`/api/documents/${slug}`)
      .then((r) => r.json())
      .then((d) => { if (d.title) setDocTitle(d.title); })
      .catch(() => {});
  }, [slug]);

  const handleJoin = useCallback(
    (info: UserInfo) => {
      localStorage.setItem(`collab:doc:${slug}:joined`, 'true');
      setUserInfo(info);
      setShowJoinModal(false);
    },
    [slug],
  );

  const {
    editorContainerRef,
    peers,
    language,
    setLanguage,
    connectedCount,
    isConnected,
    connStatus,
    retryConnect,
  } = useCollabEditor(slug, userInfo);

  return (
    <div className={styles.page}>
      <Toolbar
        docTitle={docTitle}
        language={language}
        onLanguageChange={setLanguage}
        connectedCount={connectedCount}
        isConnected={isConnected}
        connStatus={connStatus}
        onRetryConnect={retryConnect}
      />

      <main className={styles.editorPane}>
        <div
          ref={editorContainerRef}
          className={styles.editorContainer}
          data-testid="editor-container"
        />
      </main>

      <PresenceSidebar peers={peers} selfInfo={userInfo} />

      {showJoinModal && <JoinModal onJoin={handleJoin} />}
    </div>
  );
}
