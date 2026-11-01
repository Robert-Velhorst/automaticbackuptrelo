import { createBackupApp } from './backup-app.js';
import { uploadCsvBackup } from './drive-backup.js';
import 'dotenv/config';
import axios from 'axios';
import Bottleneck from 'bottleneck';


/* ============================================================
 *  🔹 1. GOOGLE DRIVE AUTH (ENV TOKEN)
 * ============================================================ */
/* ============================================================
 *  🔹 2. TRELLO VERİLERİNİ ÇEK (ARŞİV + CUSTOM FIELDS + ACTIONS)
 * ============================================================ */
function getCardCreationDate(cardId) {
  const timestamp = parseInt(cardId.substring(0, 8), 16);
  return new Date(timestamp * 1000).toISOString();
}

function formatCustomFieldValue(item, boardCustomFieldsById) {
  const def = boardCustomFieldsById[item.idCustomField];
  if (!def) return null;

  const name = def.name || def.id;

  if (item.value?.text != null) return `${name}=${item.value.text}`;
  if (item.value?.number != null) return `${name}=${item.value.number}`;
  if (item.value?.date != null) return `${name}=${item.value.date}`;
  if (typeof item.value?.checked !== 'undefined') {
    return `${name}=${item.value.checked ? 'true' : 'false'}`;
  }
  if (item.idValue) {
    const opt = (def.options || []).find(o => o.id === item.idValue);
    const optText = opt?.value?.text || opt?.value?.label || opt?.id || 'option';
    return `${name}=${optText}`;
  }
  return `${name}=[unknown]`;
}

function extractArchiveTimestamps(actions) {
  let archivedAt = '';
  let unarchivedAt = '';

  for (const a of actions) {
    if (a.type === 'updateCard' && a.data?.old && a.data?.card) {
      const oldClosed = a.data.old.closed;
      const newClosed = a.data.card.closed;

      if (oldClosed === false && newClosed === true && !archivedAt) {
        archivedAt = a.date;
      }
      if (oldClosed === true && newClosed === false && !unarchivedAt) {
        unarchivedAt = a.date;
      }
    }
  }
  return { archivedAt, unarchivedAt };
}

async function fetchTrelloData() {
  const { TRELLO_KEY, TRELLO_TOKEN } = process.env;
  const base = `https://api.trello.com/1`;
  const params = `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

  console.log('🔄 Trello verileri çekiliyor...');
  const limiter = new Bottleneck({ minTime: 200 });

  const boardsRes = await limiter.schedule(() =>
    axios.get(`${base}/members/me/boards?filter=all&${params}`)
  );
  const boards = boardsRes.data;
  const allData = [];

  for (const board of boards) {
    const listsRes = await limiter.schedule(() =>
      axios.get(`${base}/boards/${board.id}/lists?filter=all&${params}`)
    );
    const lists = listsRes.data;
    const listsById = new Map(lists.map(l => [l.id, l]));

    let boardCustomFields = [];
    try {
      const cfRes = await limiter.schedule(() =>
        axios.get(`${base}/boards/${board.id}/customFields?${params}`)
      );
      boardCustomFields = cfRes.data || [];
    } catch {}

    const boardCustomFieldsById = {};
    for (const def of boardCustomFields) {
      boardCustomFieldsById[def.id] = def;
    }

    const cardsRes = await limiter.schedule(() =>
      axios.get(`${base}/boards/${board.id}/cards?filter=all&${params}`)
    );
    const cards = cardsRes.data;

    for (const card of cards) {
      try {
        const [
          labelsRes,
          membersRes,
          checklistsRes,
          attachmentsRes,
          commentsRes,
          actionsRes,
          customFieldItemsRes
        ] = await Promise.all([
          limiter.schedule(() => axios.get(`${base}/cards/${card.id}/labels?${params}`)),
          limiter.schedule(() => axios.get(`${base}/cards/${card.id}/members?${params}`)),
          limiter.schedule(() => axios.get(`${base}/cards/${card.id}/checklists?${params}`)),
          limiter.schedule(() => axios.get(`${base}/cards/${card.id}/attachments?${params}`)),
          limiter.schedule(() =>
            axios.get(`${base}/cards/${card.id}/actions?filter=commentCard&limit=1000&${params}`)
          ),
          limiter.schedule(() =>
            axios.get(`${base}/cards/${card.id}/actions?filter=updateCard,createCard,copyCard,moveCardFromBoard,moveCardToBoard&limit=1000&${params}`)
          ),
          limiter.schedule(() =>
            axios.get(`${base}/cards/${card.id}/customFieldItems?${params}`)
          )
        ]);

        const list = listsById.get(card.idList);
        const { archivedAt, unarchivedAt } = extractArchiveTimestamps(actionsRes.data || []);

        const comments = (commentsRes.data || [])
          .map(c => `${c.memberCreator?.fullName || 'Unknown'}: ${c.data?.text || ''}`)
          .join(' | ');

        const checklists = (checklistsRes.data || [])
          .map(chk =>
            `${chk.name}: ${chk.checkItems?.map(i => `${i.name} (${i.state})`).join('; ')}`
          )
          .join(' | ');

        const attachments = (attachmentsRes.data || []).map(a => a.url).join(', ');
        const labels = (labelsRes.data || []).map(l => l.name).join(', ');
        const members = (membersRes.data || []).map(m => m.fullName).join(', ');

        const custom_fields = (customFieldItemsRes.data || [])
          .map(item => formatCustomFieldValue(item, boardCustomFieldsById))
          .filter(Boolean)
          .join(' | ');

        allData.push({
          board_name: board.name,
          board_url: board.url,
          board_closed: board.closed ? 'true' : 'false',
          list_name: list?.name || '',
          list_url: `https://trello.com/b/${board.shortLink}`,
          list_closed: list?.closed ? 'true' : 'false',
          card_name: card.name,
          card_url: card.shortUrl,
          card_pos: card.pos,
          desc: card.desc,
          created_at: getCardCreationDate(card.id),
          last_activity: card.dateLastActivity || '',
          archived_at: archivedAt,
          unarchived_at: unarchivedAt,
          due: card.due || '',
          due_complete: card.dueComplete ? 'true' : 'false',
          closed: card.closed ? 'true' : 'false',
          members,
          labels,
          comments,
          checklists,
          attachments,
          custom_fields
        });
      } catch (err) {
        console.warn(`⚠️ Kart atlandı: ${card.name}`, err.message);
      }
    }
  }

  console.log(`✅ ${allData.length} kart çekildi`);
  return allData;
}

/* ============================================================
 *  🔹 3. CSV OLUŞTUR + DRIVE YÜKLE
 * ============================================================ */
const app = createBackupApp({
  password: process.env.APP_PASSWORD,
  publicOrigin: process.env.PUBLIC_URL,
  background: false,
  runBackup: async () => uploadCsvBackup(await fetchTrelloData()),
});
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Backup service listening on ${host}:${port}`));
