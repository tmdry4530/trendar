// RepoRow.tsx — 레포 목록 테이블 행 컴포넌트.
import { useNavigate } from 'react-router-dom';
import type { Repo } from '../types';
import { formatStars, formatDelta, formatPercent } from '../lib/format';
import styles from './RepoRow.module.css';

interface Props {
  repo: Repo;
  onOpen: (id: number) => void;
  onToggleBookmark: (repo: Repo) => void;
  onDelete: (repo: Repo) => void;
}

export default function RepoRow({ repo, onOpen, onToggleBookmark, onDelete }: Props) {
  const navigate = useNavigate();

  const handleRowClick = () => {
    onOpen(repo.id);
    navigate(`/repos/${repo.id}`);
  };

  const handleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleBookmark(repo);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(repo);
  };

  const growthClass =
    repo.growth_rate > 0
      ? 'delta delta--up'
      : repo.growth_rate < 0
        ? 'delta delta--down'
        : 'delta delta--flat';

  return (
    <tr onClick={handleRowClick}>
      {/* bookmark */}
      <td className={styles.cellIcon}>
        <button
          type="button"
          className="btn btn--icon btn--ghost"
          onClick={handleBookmark}
          aria-label={repo.is_bookmarked ? '북마크 해제' : '북마크'}
          title={repo.is_bookmarked ? '북마크 해제' : '북마크'}
        >
          {repo.is_bookmarked ? (
            <span className={styles.starOn} aria-hidden>★</span>
          ) : (
            <span className={styles.starOff} aria-hidden>☆</span>
          )}
        </button>
      </td>

      {/* repo name + description */}
      <td className={styles.cellRepo}>
        <b className="mono truncate">{repo.full_name}</b>
        {repo.description && (
          <div className={`muted truncate ${styles.desc}`}>{repo.description}</div>
        )}
      </td>

      {/* language */}
      <td>
        {repo.language ? (
          <span className="tag">{repo.language}</span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>

      {/* stars */}
      <td className="col-num">
        <span className="stars">★ {formatStars(repo.stars)}</span>
      </td>

      {/* growth / delta */}
      <td className="col-num">
        <span className={growthClass}>{formatPercent(repo.growth_rate)}</span>
        <div className={`muted ${styles.deltaSmall}`}>{formatDelta(repo.star_delta)}</div>
      </td>

      {/* delete */}
      <td className={styles.cellAction}>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          onClick={handleDelete}
          aria-label={`${repo.full_name} 삭제`}
        >
          삭제
        </button>
      </td>
    </tr>
  );
}
