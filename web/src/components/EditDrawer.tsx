import { useEffect, useMemo, useState } from 'react';
import { App, Button, Drawer, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import SqlEditor from './SqlEditor';
import StringMapEditor from './StringMapEditor';
import { createDataset, fetchLabelMap, updateDataset } from '../api';
import type { ACL, DatasetConfig, RowFilter, RowRule, StringMap } from '../types';

interface Props {
  open: boolean;
  record: DatasetConfig | null; // null 表示新建
  onClose: () => void;
  onSaved: () => void;
}

// 行级过滤的两条规则：tenant 取登录态租户，user 取登录态可见用户。
const ROW_RULE_KINDS: Array<{ key: 'tenant' | 'user'; label: string; hint: string }> = [
  { key: 'tenant', label: '按登录态租户', hint: '取值来自请求头 X-Tenants' },
  { key: 'user', label: '按可见用户', hint: '取值来自请求头 X-Visible-Users' },
];

export default function EditDrawer({ open, record, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  // dataset_key 在编辑态不可修改：它是全局业务主键，被下游引用，
  // 改名等于换了一条配置。真要改名应当新建 + 停用旧的。
  const isEdit = record !== null;

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [midSQL, setMidSQL] = useState('');
  const [dimMap, setDimMap] = useState<StringMap>({});
  const [mtxMap, setMtxMap] = useState<StringMap>({});
  const [labelMap, setLabelMap] = useState<StringMap>({});
  const [aclText, setAclText] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  // 全局字段名称字典，用来提示哪条中文名是继承来的。拉不到就当没有，不影响编辑。
  const [globalLabels, setGlobalLabels] = useState<StringMap>({});

  useEffect(() => {
    if (!open) return;
    void fetchLabelMap()
      .then((res) => setGlobalLabels(res.label_map ?? {}))
      .catch(() => setGlobalLabels({}));
  }, [open]);

  // 本数据集没有单独定义、但全局字典里有的字段——它们会直接用全局的中文名。
  // 列出来是为了让人知道「我没配不代表没名字」，也方便发现同名不同义。
  const inheritedPreview = useMemo(() => {
    const out: Array<[string, string]> = [];
    for (const k of [...Object.keys(dimMap), ...Object.keys(mtxMap)]) {
      if (k in labelMap) continue;
      const g = globalLabels[k];
      if (g) out.push([k, g]);
    }
    return out;
  }, [dimMap, mtxMap, labelMap, globalLabels]);

  useEffect(() => {
    if (!open) return;
    if (record) {
      setKey(record.dataset_key);
      setName(record.dataset_name);
      setMidSQL(record.mid_sql);
      setDimMap(record.dim_map ?? {});
      setMtxMap(record.mtx_map ?? {});
      setLabelMap(record.label_map ?? {});
      setAclText(JSON.stringify(record.acl ?? {}, null, 2));
      setEnabled(record.status === 1);
    } else {
      setKey('');
      setName('');
      setMidSQL('');
      setDimMap({});
      setMtxMap({});
      setLabelMap({});
      setAclText('{}');
      setEnabled(true);
    }
  }, [open, record]);

  // 把 dim_map / mtx_map 里还没配中文名的键补进来，省得逐个手敲
  const fillLabels = () => {
    const next: StringMap = { ...labelMap };
    for (const k of [...Object.keys(dimMap), ...Object.keys(mtxMap)]) {
      if (!(k in next)) next[k] = '';
    }
    setLabelMap(next);
  };

  // acl 以纯 JSON 编辑：结构灵活（后续会加 roles 等维度），
  // 与其为每个维度做一套表单控件，不如直接编辑 JSON，校验交给后端。
  const parsedACL = useMemo<ACL | null>(() => {
    try {
      return JSON.parse(aclText) as ACL;
    } catch {
      return null;
    }
  }, [aclText]);
  const aclError = useMemo(() => {
    try {
      JSON.parse(aclText);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  }, [aclText]);

  // 行级过滤的开关与列名只是 acl JSON 的可视化入口：不额外存一份状态，
  // 每次改动直接写回 JSON 文本，避免表单与 JSON 两处不一致。
  const rowFilter = useMemo<RowFilter>(() => {
    const rf = parsedACL?.row_filter ?? {};
    return {
      tenant: { enabled: false, ...(rf.tenant ?? {}) },
      user: { enabled: false, ...(rf.user ?? {}) },
    };
  }, [parsedACL]);

  const patchRowFilter = (kind: 'tenant' | 'user', patch: Partial<RowRule>) => {
    const next: RowRule = { ...(rowFilter[kind] ?? { enabled: false }), ...patch };
    const normalized: RowRule = { enabled: !!next.enabled };
    if (normalized.enabled && next.column) normalized.column = next.column;
    const nextRF: RowFilter = { ...rowFilter, [kind]: normalized };
    const base: ACL = { ...(parsedACL ?? {}) };
    // 两条规则都关掉时把 row_filter 整个摘掉，别留一个空壳在 JSON 里
    if (nextRF.tenant?.enabled || nextRF.user?.enabled) {
      base.row_filter = nextRF;
    } else {
      delete base.row_filter;
    }
    setAclText(JSON.stringify(base, null, 2));
  };

  // 行级过滤发生在聚合前，列名只能映射到 dim_map 的维度：
  // mtx_map 是 sum(...) 这类聚合结果，放进 WHERE 会被 ClickHouse 拒绝。
  const dimOptions = useMemo(() => {
    const cols = new Set(Object.keys(dimMap));
    for (const k of ['tenant', 'user'] as const) {
      const c = rowFilter[k]?.column;
      if (c) cols.add(c);
    }
    return [...cols].map((v) => ({ value: v, label: v }));
  }, [dimMap, rowFilter]);

  const save = async () => {
    if (!key.trim()) {
      message.warning('请填写 dataset_key');
      return;
    }
    if (!name.trim()) {
      message.warning('请填写 dataset_name');
      return;
    }
    if (!midSQL.trim()) {
      message.warning('请填写 mid_sql');
      return;
    }
    if (aclError) {
      message.error(`acl 不是合法 JSON：${aclError}`);
      return;
    }
    // 开了行级过滤就必须指定列，否则后端会以 400 拒绝，这里提前拦一下
    const rf = (JSON.parse(aclText) as ACL).row_filter ?? {};
    for (const kind of ['tenant', 'user'] as const) {
      if (rf[kind]?.enabled && !(rf[kind]?.column ?? '').trim()) {
        message.warning(`行级权限：${kind === 'tenant' ? '按登录态租户' : '按可见用户'}已开启，请选择映射的维度`);
        return;
      }
    }
    const parsedACL = JSON.parse(aclText) as ACL;
    setSaving(true);
    try {
      if (isEdit && record) {
        await updateDataset(record.dataset_key, {
          dataset_name: name.trim(),
          mid_sql: midSQL,
          dim_map: dimMap,
          mtx_map: mtxMap,
          label_map: labelMap,
          acl: parsedACL,
          status: enabled ? 1 : 0,
          version: record.version,
        });
        message.success('已保存');
      } else {
        await createDataset({
          dataset_key: key.trim().toLowerCase(),
          dataset_name: name.trim(),
          mid_sql: midSQL,
          dim_map: dimMap,
          mtx_map: mtxMap,
          label_map: labelMap,
          acl: parsedACL,
          status: enabled ? 1 : 0,
        });
        message.success('已创建');
      }
      onSaved();
    } catch (e) {
      const msg = (e as Error).message || '保存失败';
      if (msg.includes('version conflict')) {
        message.error('该配置已被他人修改，请刷新后重新编辑');
      } else {
        message.error(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={900}
      title={isEdit ? `编辑 ${record?.dataset_key ?? ''}` : '新建 dataset'}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item
          label="dataset_key"
          required
          extra={
            isEdit
              ? '全局唯一，创建后不可修改（如需改名请新建配置并停用旧的）'
              : '全局唯一，仅允许小写字母、数字、下划线、短横线、点号'
          }
        >
          <Input
            value={key}
            disabled={isEdit}
            placeholder="例如 order_daily"
            onChange={(e) => setKey(e.target.value)}
          />
        </Form.Item>

        <Form.Item label="dataset_name" required>
          <Input value={name} placeholder="例如 订单日报" onChange={(e) => setName(e.target.value)} />
        </Form.Item>

        <Form.Item label="status">
          <Space>
            <Switch checked={enabled} onChange={setEnabled} checkedChildren="启用" unCheckedChildren="停用" />
            <Typography.Text type="secondary">停用的配置不会被下游加载</Typography.Text>
          </Space>
        </Form.Item>

        <Form.Item
          label={
            <Space>
              <span>mid_sql</span>
              <Typography.Text type="secondary">
                支持 Go template，不做语法校验 · {midSQL.length} 字符 /{' '}
                {new Blob([midSQL]).size} 字节
              </Typography.Text>
            </Space>
          }
          extra={
            <Space direction="vertical" size={2}>
              <span>
                中间结果 SQL：输出应可被再次聚合，所以不要写 ORDER BY / LIMIT。
                不含 {'{{'} 时按纯 SQL 处理，与以前完全一样。
              </span>
              <span>
                可用变量 <Typography.Text code>.Dims .Metrics .Fields .Filters</Typography.Text>
                ，判断方法{' '}
                <Typography.Text code>
                  {'.Has .HasAny .HasAll .HasDim .HasMetric'}
                </Typography.Text>
                。用不到的维表 JOIN 可以在模板里省掉，例：
              </span>
              <Typography.Text code>
                {'{{ if .HasAny "city_name" "city_tier" }} left join dim_city c on ... {{ end }}'}
              </Typography.Text>
              <span>
                注意：裁掉 JOIN 的正确性由配置者保证——只有确认是 LEFT JOIN 且关联键在右表唯一
                （不会放大行数）时才可裁，否则聚合结果会偏小。
              </span>
            </Space>
          }
          required
        >
          <SqlEditor value={midSQL} onChange={setMidSQL} />
        </Form.Item>

        <Form.Item label="dim_map" extra="map[string]string，可用表格或 JSON 两种方式编辑">
          <StringMapEditor
            value={dimMap}
            onChange={setDimMap}
            placeholderKey="维度名，例如 city"
            placeholderValue="映射表达式，例如 city_code"
          />
        </Form.Item>

        <Form.Item label="mtx_map" extra="map[string]string，可用表格或 JSON 两种方式编辑">
          <StringMapEditor
            value={mtxMap}
            onChange={setMtxMap}
            placeholderKey="指标名，例如 cost"
            placeholderValue="聚合表达式，例如 sum(stat_cost)"
          />
        </Form.Item>

        <Form.Item
          label="label_map"
          extra={
            <Space direction="vertical" size={2}>
              <Space>
                <span>
                  中文含义，只影响查询页的展示，不参与 SQL 生成。留空 = 继承全局定义；
                  填了 = 只覆盖本数据集；想彻底不用中文名就删掉整行
                </span>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={fillLabels}>
                  按维度/指标补齐
                </Button>
              </Space>
              {inheritedPreview.length > 0 && (
                <Space size={4} wrap>
                  <Typography.Text type="secondary">继承全局：</Typography.Text>
                  {inheritedPreview.map(([k, v]) => (
                    <Tag key={k} color="blue">
                      {k} → {v}
                    </Tag>
                  ))}
                </Space>
              )}
            </Space>
          }
        >
          <StringMapEditor
            value={labelMap}
            onChange={setLabelMap}
            placeholderKey="维度或指标名，例如 cost"
            placeholderValue="中文含义，例如 消耗"
            inherited={globalLabels}
          />
        </Form.Item>

        <Form.Item
          label="行级权限"
          extra={
            <Space direction="vertical" size={2}>
              <span>
                开启后，查询时会自动往 WHERE 追加「该维度 IN (登录态取值)」，对 /query/execute
                与维度候选值接口同时生效；条件由服务端注入，前端传参无法绕过。
              </span>
              <span>
                只能映射到 dim_map 的维度——行级过滤发生在聚合前，mtx_map 是聚合结果，放不进 WHERE。
              </span>
              <span>
                登录态对应列表为空时按 fail-closed 处理：该数据集查不到任何行（不是放行全量）。
              </span>
            </Space>
          }
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {ROW_RULE_KINDS.map(({ key, label, hint }) => (
              <Space key={key} size={8} wrap>
                <Switch
                  size="small"
                  disabled={!!aclError}
                  checked={!!rowFilter[key]?.enabled}
                  onChange={(v) => patchRowFilter(key, { enabled: v })}
                />
                <Typography.Text style={{ display: 'inline-block', width: 100 }}>{label}</Typography.Text>
                <Select
                  size="small"
                  allowClear
                  showSearch
                  disabled={!!aclError || !rowFilter[key]?.enabled}
                  style={{ minWidth: 200 }}
                  placeholder="选择 dim_map 里的维度"
                  value={rowFilter[key]?.column || undefined}
                  onChange={(v) => patchRowFilter(key, { column: v ?? '' })}
                  options={dimOptions}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {hint}
                </Typography.Text>
              </Space>
            ))}
          </Space>
        </Form.Item>

        <Form.Item
          label="acl"
          validateStatus={aclError ? 'error' : undefined}
          help={aclError || undefined}
          extra={
            <Space direction="vertical" size={2}>
              <span>
                数据集级 + 列级租户白名单，用于查询页的权限管控。不配置表示不限制；
                配置了则登录态租户与白名单有交集才可见。
              </span>
              <Typography.Text code>
                {`{"tenants": ["t1","t2"], "col_tenants": {"${[...Object.keys(dimMap), ...Object.keys(mtxMap)][0] ?? 'cost'}": ["t1"]}, "row_filter": {"tenant": {"enabled": true, "column": "${Object.keys(dimMap)[0] ?? 'tenant'}"}}}`}
              </Typography.Text>
              <span>
                col_tenants 的 key 必须是下面的维度或指标名之一：
                {[...Object.keys(dimMap), ...Object.keys(mtxMap)].join('、') || '（请先填维度/指标）'}
              </span>
              <span>上面的行级权限控件会同步写入这段 JSON 的 row_filter 字段。</span>
            </Space>
          }
        >
          <Input.TextArea
            value={aclText}
            onChange={(e) => setAclText(e.target.value)}
            rows={6}
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
