// Defaults shown until the admin saves something, plus sanitizers for incoming data.

export const DEFAULT_CONTENT = {
  hero: {
    subtitle: '청계천의 동물들과 함께 호흡하는 연구실',
    critters: '🦆 🐟 🐦 🐢 🦢',
  },
  welcome: {
    title: '환영합니다',
    body: [
      '안녕하세요, 저희는 **HAI(Human Animal Interaction) 연구실**입니다.',
      'HAI LAB은 서울 도심 한가운데를 흐르는 **청계천**과 그곳에 터를 잡고 살아가는 동물들을 연구합니다. 물가를 거니는 왜가리, 여유롭게 떠다니는 청둥오리, 돌 틈을 누비는 물고기들까지 — 저희는 이들을 단순히 관찰하는 데 그치지 않고, 사람과 동물 사이의 **교감**을 탐구합니다.',
      '청계천을 걷다 오리와 눈이 마주쳤다면, 당신도 이미 HAI 연구에 한 발 들인 것입니다.',
    ].join('\n\n'),
    keywords: ['청계천', '도심생태', '교감', '오리관찰', '산책기반연구'],
  },
  professor: {
    name: '조정인 교수',
    role: 'Principal Investigator, HAI LAB',
    emoji: '🧑‍🏫',
    photo: '',
    items: [
      { label: '연구분야', value: '청계천 동물 행동학, 인간-동물 교감론' },
      { label: '주요업적', value: '청계천 오리와 3초 이상 눈 마주치기 성공' },
      { label: '연구실', value: '청계천 산책로 어딘가 (벤치 3번)' },
      { label: '한마디', value: '"동물은 말이 없지만, 다 알고 있습니다."' },
    ],
  },
  members: [
    { emoji: '🦆', name: '홍석주', pos: '석박사통합과정', desc: '청계천 돌바닥 간격 연구', photo: '' },
    { emoji: '🐟', name: '멤버 2', pos: '석사과정', desc: '청계천 어류와의 비언어적 소통', photo: '' },
    { emoji: '🐦', name: '멤버 3', pos: '학부연구생', desc: '왜가리의 사냥 집중력 관찰', photo: '' },
  ],
  contact: [
    { label: 'Email', value: 'hailab@example.com', href: 'mailto:hailab@example.com' },
    { label: 'Location', value: '서울특별시 청계천 일대\n(주로 광통교 ~ 오간수교 구간)', href: '' },
    { label: 'Office Hours', value: '날씨 좋은 날, 오리가 나올 때', href: '' },
  ],
  footer: '© 2026 HAI LAB · Human Animal Interaction Laboratory · 청계천의 모든 생명에게 감사를 🦆',
};

export const DEFAULT_PAPERS = [
  {
    id: 'welcome-paper',
    title: '청계천 청둥오리는 왜 한쪽 발로 서는가: 예비 관찰 보고',
    authors: '홍석주, 조정인',
    date: '2026-09-21',
    tags: ['오리', '예비연구'],
    body: [
      '**초록**',
      '본 연구는 청계천에 서식하는 청둥오리가 한쪽 발로 서는 행동을 관찰하였다. 연구진은 벤치 3번에 앉아 약 40분간 오리를 바라보았으며, 오리 역시 연구진을 바라보았다.',
      '',
      '**결론**',
      '오리는 한쪽 발로 섰다. 이유는 알 수 없었다. 추가 연구가 필요하다.',
    ].join('\n'),
  },
];

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' ? v : {});

export function cleanContent(input) {
  const c = obj(input);
  const hero = obj(c.hero);
  const welcome = obj(c.welcome);
  const prof = obj(c.professor);
  return {
    hero: { subtitle: str(hero.subtitle, 200), critters: str(hero.critters, 100) },
    welcome: {
      title: str(welcome.title, 100),
      body: str(welcome.body, 5000),
      keywords: list(welcome.keywords, 30).map((k) => str(k, 40)).filter(Boolean),
    },
    professor: {
      name: str(prof.name, 60),
      role: str(prof.role, 120),
      emoji: str(prof.emoji, 20),
      photo: str(prof.photo, 500),
      items: list(prof.items, 30).map((i) => ({ label: str(obj(i).label, 40), value: str(obj(i).value, 300) })),
    },
    members: list(c.members, 100).map((m) => {
      m = obj(m);
      return { emoji: str(m.emoji, 20), name: str(m.name, 50), pos: str(m.pos, 50), desc: str(m.desc, 300), photo: str(m.photo, 500) };
    }),
    contact: list(c.contact, 20).map((x) => {
      x = obj(x);
      return { label: str(x.label, 40), value: str(x.value, 300), href: str(x.href, 500) };
    }),
    footer: str(c.footer, 300),
  };
}

export function cleanPapers(input) {
  return list(input, 1000)
    .map((p) => {
      p = obj(p);
      return {
        id: str(p.id, 40) || Math.random().toString(36).slice(2, 10),
        title: str(p.title, 200),
        authors: str(p.authors, 200),
        date: /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : '',
        tags: list(p.tags, 10).map((t) => str(t, 30)).filter(Boolean),
        body: str(p.body, 20000),
      };
    })
    .filter((p) => p.title);
}
