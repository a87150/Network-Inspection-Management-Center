/* 分析详情弹窗里的问题明细：直接复用 workspace-table，能力与工作区表格完全一致。
   后端已经把行数据做成 table_payload，这里不需要再包一层。 */
import WorkspaceTable from '../components/workspace_table.mjs';

export default {
    ...WorkspaceTable,
    delimiters: ['[[', ']]'],
    props: {
        ...WorkspaceTable.props,
        tableKey: {type: String, default: 'analysis-problems'},
        label: {type: String, default: '问题明细'},
        regionLabel: {type: String, default: '问题明细数据表'},
        emptyTitle: {type: String, default: '该任务暂无此类问题'},
    },
};
