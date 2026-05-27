import type { PresenceState, UserInfo } from '../../types';
import styles from './PresenceSidebar.module.scss';

interface PresenceSidebarProps {
  peers: PresenceState[];
  selfInfo: UserInfo | null;
}

export function PresenceSidebar({ peers, selfInfo }: PresenceSidebarProps) {
  const allUsers = selfInfo
    ? [
        {
          userId: selfInfo.userId,
          displayName: `${selfInfo.displayName} (you)`,
          color: selfInfo.color,
          isSelf: true,
        },
        ...peers.map((p) => ({ ...p, isSelf: false })),
      ]
    : peers.map((p) => ({ ...p, isSelf: false }));

  return (
    <aside className={styles.sidebar} aria-label="People in this document">
      <p className={styles.heading} aria-hidden="true">
        In this document
      </p>
      <ul className={styles.list} role="list" data-testid="presence-list">
        {allUsers.map((user) => (
          <li
            key={user.userId}
            className={styles.item}
            role="listitem"
            data-testid="presence-item"
          >
            <span
              className={styles.chip}
              style={{ backgroundColor: user.color }}
              title={user.displayName}
            >
              <span
                className={styles.dot}
                style={{ backgroundColor: 'rgba(255,255,255,0.5)' }}
              />
              <span className={styles.name}>{user.displayName}</span>
            </span>
          </li>
        ))}
        {allUsers.length === 0 && (
          <li className={styles.selfLabel}>No one else here</li>
        )}
      </ul>
    </aside>
  );
}
