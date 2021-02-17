#include <glpk.h>

#include <algorithm>
#include <climits>
#include <cstring>
#include <queue>
#include <vector>

// #include "emscripten.h"
using namespace std;

#define DOUBLE_EPS 1e-8

namespace Renderer {

int isTolerance = 0;
int ISMethod = 1;
int applyDFS = 1;
int dfsTolerance = 0;
int LPIters = 100;
int LPModel = 3;
int MILP = 0;

glp_smcp parm;

struct ScheduleBlock {
    /**
     * whether this block is movable/expandable
     * i.e. whether there's still room for it to change its left and width) 
    */
    bool isFixed;
    /**
     *  visited flag used in BFS/DFS 
     **/
    bool visited;

    int16_t startMin;
    int16_t endMin;
    int16_t duration;

    /** 
     * an unique index for this scheduleBlock 
     * */
    int idx;
    /** 
     * depth/room assignment obtained from the interval scheduling algorithm 
     * */
    int depth;
    /**
     * the maximum depth (number of rooms) that the current block is on
     * Equal to the maximum depth of the block 
     * on the right hand side of this block that also conflicts with this blocks
     */
    int pathDepth;
    double left;
    double width;

    /**
     * all blocks that conflict with the current block and also on the LHS of the current block
    */
    vector<ScheduleBlock*> leftN;
    /**
     * all blocks that conflict with the current block and also on the RHS of the current block
    */
    vector<ScheduleBlock*> rightN;
    /**
     * cleftN: Condensed leftN
     * a subset of leftN. For each node in leftN, it belongs to cleftN if and only if 
     * it is not in the leftN of any node that is in leftN
     */
    vector<ScheduleBlock*> cleftN;
    /**
     * crightN: Condensed rightN
     * a subset of rightN. For each node in rightN, it belongs to crightN if and only if 
     * it is not in the rightN of any node that is in rightN
     */
    vector<ScheduleBlock*> crightN;
};

ScheduleBlock* __restrict__ blocks = NULL;
// pointers to blocks, but may be reordered
// never change the order of elements in blocks. Instead, change this variable
ScheduleBlock** __restrict__ blocksReordered = NULL;
// a working buffer for BFS/LP models, usually not full
ScheduleBlock** __restrict__ blockBuffer = NULL;

int* __restrict__ idxMap = NULL;
/**
 * matrix[i*N+j] is true iff event j is on the LHS of event i
*/
bool* __restrict__ matrix = NULL;

// --------- results -----------------
double r_sum;
double r_sumSq;
// --------- results -----------------

int maxN = 0;
int N = 0;

void computeResult() {
    for (int i = 0; i < N; i++) {
        double w = blocks[i].width * 100;
        r_sum += w;
        r_sumSq += w * w;
    }
}

void sortByStartTime() {
    sort(blocksReordered, blocksReordered + N,
         [](const ScheduleBlock* b1, const ScheduleBlock* b2) {
             int diff = b1->startMin - b2->startMin;
             if (diff == 0) return b2->duration - b1->duration < 0;
             return diff < 0;
         });
}

/**
 * a modified interval partitioning algorithm, runs in worst case O(n^2)
 * besides using the fewest possible rooms, it also tries to assign events to the rooms with the lowest possible index
 * @returns the total number of rooms
 */
int intervalScheduling() {
    if (N == 0) return 0;

    sortByStartTime();
    blockBuffer[0] = blocksReordered[0];  // occupied room
    int occupiedSize = 1;
    int numRooms = 0;
    for (int i = 1; i < N; i++) {
        auto block = blocksReordered[i];
        int idx = -1;
        int minRoomIdx = INT_MAX;
        for (int k = 0; k < occupiedSize; k++) {
            auto* prevBlock = blockBuffer[k];
            if (prevBlock->endMin <= block->startMin + isTolerance &&
                prevBlock->depth < minRoomIdx) {
                minRoomIdx = prevBlock->depth;
                idx = k;
            }
        }
        if (idx == -1) {
            numRooms += 1;
            block->depth = numRooms;
            blockBuffer[occupiedSize++] = block;
        } else {
            block->depth = blockBuffer[idx]->depth;
            blockBuffer[idx] = block;
        }
    }
    numRooms += 1;
    return numRooms;
}

/**
 * the classical interval scheduling algorithm, runs in O(n log n)
 * @returns the total number of rooms
 */
int intervalScheduling2() {
    if (N == 0) return 0;

    sortByStartTime();
    // min heap, the top element is the room whose end time is minimal
    // a room is represented as a pair: [end time, room index]
    auto comp = [](const ScheduleBlock* r1, const ScheduleBlock* r2) {
        int diff = r1->endMin - r2->endMin;
        if (diff == 0) return r1->depth - r2->depth > 0;
        return diff > 0;
    };
    priority_queue<ScheduleBlock*, vector<ScheduleBlock*>, decltype(comp)>
        queue(comp);
    queue.push(blocksReordered[0]);

    int numRooms = 0;
    int tolerance = isTolerance;
    for (int i = 1; i < N; i++) {
        auto block = blocksReordered[i];
        auto prevBlock = queue.top();
        if (prevBlock->endMin + tolerance > block->startMin) {
            // conflict, need to add a new room
            numRooms += 1;
            block->depth = numRooms;
        } else {
            block->depth = prevBlock->depth;
            queue.pop();  // update the room end time
        }
        queue.push(block);
    }
    return numRooms + 1;
}

/**
 * for the array of schedule blocks provided, construct an adjacency list
 * to represent the conflicts between each pair of blocks
 * @note this function assumes blocksReordered is already sorted by start time
 */
void constructAdjList() {
    for (int i = 0; i < N; i++) {
        auto bi = blocksReordered[i];
        for (int j = i + 1; j < N; j++) {
            auto bj = blocksReordered[j];
            if (bj->startMin + dfsTolerance >= bi->endMin) break;
            if (bi->depth < bj->depth) {
                matrix[bj->idx * N + bi->idx] = 1;
                bj->leftN.push_back(bi);
                bi->rightN.push_back(bj);
            } else {
                matrix[bi->idx * N + bj->idx] = 1;
                bj->rightN.push_back(bi);
                bi->leftN.push_back(bj);
            }
        }
    }
}

/**
 * @note one of the bottle necks of the algorithm, if enabled
 */
void condenseAdjList(ScheduleBlock* end) {
    for (auto block = blocks; block < end; block++) {
        for (auto v1 : block->leftN) {
            for (auto v : block->leftN) {
                if (matrix[v->idx * N + v1->idx]) goto nextl1;
            }
            block->cleftN.push_back(v1);
        nextl1:;
        }
        for (auto v1 : block->rightN) {
            for (auto v : block->rightN) {
                if (matrix[v1->idx * N + v->idx]) goto nextl2;
            }
            block->crightN.push_back(v1);
        nextl2:;
        }
    }
}

/**
 * find the connected component containing start and other nodes that are not fixed
 * the nodes in this component will be stored on the blockBuffer global array
 * @returns the number of nodes in this component 
 */
int BFS(ScheduleBlock* start) {
    int qIdx = 0;
    int NC = 1;
    blockBuffer[0] = start;
    start->visited = true;
    while (qIdx < NC) {
        for (auto node : blockBuffer[qIdx]->cleftN) {
            if (!node->visited) {
                node->visited = true;
                blockBuffer[NC++] = node;
            }
        }
        for (auto node : blockBuffer[qIdx]->crightN) {
            if (!node->visited) {
                node->visited = true;
                blockBuffer[NC++] = node;
            }
        }
        qIdx++;
    }
    return NC;
}

/**
 * A special implementation of depth first search on a single connected component,
 * used to find the maximum depth of the path that the current node is on.
 *
 * We start from the node of the greatest depth and traverse to the lower depths
 *
 * The depth of all nodes are known beforehand (from the room assignment).
 */
void depthFirstSearchRec(ScheduleBlock* start, int maxDepth) {
    blockBuffer[0] = start;
    int size = 1;
    while (size > 0) {
        start = blockBuffer[--size];
        start->visited = true;
        start->pathDepth = maxDepth;
        for (auto adj : start->cleftN) {
            if (!adj->visited) {
                blockBuffer[size++] = adj;
            }
        }
    }
}

bool DFSFindFixedNumerical(ScheduleBlock* start) {
    start->visited = true;
    double startLeft = start->left;
    // equality here should be fine
    if (startLeft == 0.0) return (start->isFixed = true);

    bool flag = false;
    for (auto adj : start->cleftN) {
        if (abs(startLeft - adj->left - adj->width) < DOUBLE_EPS) {
            if (adj->visited) {
                flag = adj->isFixed || flag;
            } else {
                // be careful of the short-circuit evaluation
                flag = DFSFindFixedNumerical(adj) || flag;
            }
        }
    }
    return (start->isFixed = flag);
}

void dfsWidthExpansion() {
    sort(blocksReordered, blocksReordered + N,
         [](const ScheduleBlock* b1, const ScheduleBlock* b2) {
             return b2->depth < b1->depth;
         });

    // We start from the node of the greatest depth and traverse to the lower
    // depths
    for (int i = 0; i < N; i++) {
        auto node = blocksReordered[i];
        if (!node->visited) depthFirstSearchRec(node, node->depth + 1);
    }
    auto* end = blocks + N;
    for (auto block = blocks; block < end; block++) {
        block->left = static_cast<double>(block->depth) / block->pathDepth;
        block->width = 1.0 / block->pathDepth;
    }
}

vector<int> ia, ja;
vector<double> ar;

inline void addConstraint(int auxVar, int structVar, double coeff) {
    ia.push_back(auxVar);
    ja.push_back(structVar);
    ar.push_back(coeff);
}

void buildLPModel1(int NC) {
    for (int i = 0; i < NC; i++) {
        idxMap[blockBuffer[i]->idx] = 2 * i + 1;
    }
    // count the number of rows needed
    int auxVar = 0;
    for (int i = 0; i < NC; i++)
        for (auto v : blockBuffer[i]->cleftN)
            auxVar += !v->isFixed;
    glp_prob* lp = glp_create_prob();
    glp_set_obj_dir(lp, GLP_MAX);

    // preallocate rows and cols
    glp_add_cols(lp, NC * 2);
    glp_add_rows(lp, auxVar + NC);

    // index 0 is not used by glpk
    ia.resize(1);
    ja.resize(1);
    ar.resize(1);
    auxVar = 1;
    for (int i = 0; i < NC; i++) {
        auto block = blockBuffer[i];
        double maxLeftFixed = 0.0;
        double minRightFixed = 1.0;
        int leftVar = 2 * i + 1;
        for (auto v : block->cleftN) {
            if (v->isFixed)
                maxLeftFixed = max(maxLeftFixed, v->left + v->width);
            else {
                // li >= lj + wj
                addConstraint(auxVar, leftVar, 1.0);
                addConstraint(auxVar, idxMap[v->idx], -1.0);
                addConstraint(auxVar, idxMap[v->idx] + 1, -1.0);
                glp_set_row_bnds(lp, auxVar++, GLP_LO, 0.0, 0.0);
            }
        }
        for (auto v : block->crightN)
            if (v->isFixed) minRightFixed = min(v->left, minRightFixed);

        // li + wi <= minRightFixed
        addConstraint(auxVar, leftVar, 1.0);
        addConstraint(auxVar, leftVar + 1, 1.0);
        glp_set_row_bnds(lp, auxVar++, GLP_UP, 0.0, minRightFixed);

        // li >= maxLeftFixed
        glp_set_col_bnds(lp, leftVar, GLP_LO, maxLeftFixed, 0.0);

        // wi >= initialWidth
        glp_set_col_bnds(lp, leftVar + 1, GLP_LO, block->width, 0.0);
        glp_set_obj_coef(lp, leftVar, 0.0);
        glp_set_obj_coef(lp, leftVar + 1, 1.0);
    }

    glp_load_matrix(lp, ia.size() - 1, ia.data(), ja.data(), ar.data());
    glp_simplex(lp, &parm);

    // ----------------- minimize absolute deviation from the mean -----------
    glp_set_obj_dir(lp, GLP_MIN);
    double sumWidth = glp_get_obj_val(lp);
    double meanWidth = sumWidth / NC;
    glp_add_cols(lp, NC);
    glp_add_rows(lp, NC * 2 + 1);
    for (int i = 0; i < NC; i++) {
        int tVar = 2 * NC + i + 1;
        int widthVar = 2 * i + 2;

        // ti >= mean - wi
        addConstraint(auxVar, tVar, 1.0);
        addConstraint(auxVar, widthVar, 1.0);
        glp_set_row_bnds(lp, auxVar++, GLP_LO, meanWidth, 0.0);

        // ti >= wi - mean
        addConstraint(auxVar, tVar, 1.0);
        addConstraint(auxVar, widthVar, -1.0);
        glp_set_row_bnds(lp, auxVar++, GLP_LO, -meanWidth, 0.0);

        glp_set_obj_coef(lp, widthVar, 0.0);
        glp_set_obj_coef(lp, tVar, 1.0);
    }
    // sum w_i >= optimal
    for (int i = 0; i < NC; i++) {
        addConstraint(auxVar, 2 * i + 2, 1.0);
    }
    glp_set_row_bnds(lp, auxVar, GLP_LO, sumWidth - DOUBLE_EPS, 0.0);

    glp_load_matrix(lp, ia.size() - 1, ia.data(), ja.data(), ar.data());
    glp_simplex(lp, &parm);
    // ------------------------------------------------------------------

    for (int i = 0; i < NC; i++) {
        blockBuffer[i]->left = glp_get_col_prim(lp, 2 * i + 1);
        blockBuffer[i]->width = glp_get_col_prim(lp, 2 * i + 2);
    }
    glp_delete_prob(lp);
}

void buildLPModel2(int NC) {
    // map each event to an index (for structural vairable)
    for (int i = 0; i < NC; i++) {
        idxMap[blockBuffer[i]->idx] = i + 1;
    }
    // count the number of rows needed
    int auxVar = 0;
    for (int i = 0; i < NC; i++)
        for (auto v : blockBuffer[i]->cleftN)
            auxVar += !v->isFixed;
    glp_prob* lp = glp_create_prob();
    glp_set_obj_dir(lp, GLP_MAX);

    // preallocate rows and cols
    glp_add_cols(lp, NC + 1);
    glp_add_rows(lp, auxVar + NC);

    // index 0 is not used by glpk
    ia.resize(1);
    ja.resize(1);
    ar.resize(1);
    auxVar = 1;
    for (int i = 0; i < NC; i++) {
        auto block = blockBuffer[i];
        double maxLeftFixed = 0.0;
        double minRightFixed = 1.0;
        for (auto v : block->cleftN) {
            if (v->isFixed)
                maxLeftFixed = max(maxLeftFixed, v->left + v->width);
            else {
                // li >= lj + w
                addConstraint(auxVar, i + 1, 1.0);
                addConstraint(auxVar, idxMap[v->idx], -1.0);
                addConstraint(auxVar, NC + 1, -1.0);
                glp_set_row_bnds(lp, auxVar++, GLP_LO, 0.0, 0.0);
            }
        }
        for (auto v : block->crightN)
            if (v->isFixed) minRightFixed = min(v->left, minRightFixed);

        // li + w <= minRightFixed
        addConstraint(auxVar, i + 1, 1.0);
        addConstraint(auxVar, NC + 1, 1.0);
        glp_set_row_bnds(lp, auxVar++, GLP_UP, 0.0, minRightFixed);

        // li >= maxLeftFixed
        glp_set_col_bnds(lp, i + 1, GLP_LO, maxLeftFixed, 0.0);
        glp_set_obj_coef(lp, i + 1, 0.0);
    }
    // 0 <= width <= 1
    glp_set_col_bnds(lp, NC + 1, GLP_DB, 0.0, 1.0);
    // argmax(w)
    glp_set_obj_coef(lp, NC + 1, 1.0);

    glp_load_matrix(lp, ia.size() - 1, ia.data(), ja.data(), ar.data());
    glp_simplex(lp, &parm);

    double width = glp_get_col_prim(lp, NC + 1);
    for (int i = 0; i < NC; i++) {
        blockBuffer[i]->left = glp_get_col_prim(lp, i + 1);
        blockBuffer[i]->width = width;
    }
    glp_delete_prob(lp);
}

void buildMILPModel(int total) {
#define L(x) 2 * (x) + 1
#define W(x) 2 * (x) + 2
#define B(x) 2 * N + (x)
    // count the number of rows needed
    int auxVar = 0;
    for (int i = 0; i < N; i++) {
        auto bi = blocksReordered[i];
        for (int j = i + 1; j < N; j++) {
            auto bj = blocksReordered[j];
            if (bj->startMin + dfsTolerance >= bi->endMin) break;
            auxVar++;
        }
    }
    int numBV = auxVar;
    glp_prob* lp = glp_create_prob();
    glp_set_obj_dir(lp, GLP_MAX);

    // preallocate rows and cols
    glp_add_cols(lp, 2 * N + numBV);
    glp_add_rows(lp, 2 * auxVar + N);

    // index 0 is not used by glpk
    ia.resize(1);
    ja.resize(1);
    ar.resize(1);
    auxVar = 1;
    int bvIdx = 1;
    constexpr double M = 10.0;
    for (int i = 0; i < N; i++) {
        auto bi = blocksReordered[i];
        for (int j = i + 1; j < N; j++) {
            auto bj = blocksReordered[j];
            if (bj->startMin + dfsTolerance >= bi->endMin) break;
            // li + wi <= lj + My => li + wi - lj - My <= 0
            addConstraint(auxVar, L(bi->idx), 1.0);
            addConstraint(auxVar, W(bi->idx), 1.0);
            addConstraint(auxVar, L(bj->idx), -1.0);
            addConstraint(auxVar, B(bvIdx), -M);
            glp_set_row_bnds(lp, auxVar++, GLP_UP, 0.0, 0.0);

            // lj + wj <= li + M(1-y) => lj + wj - li + My <= M
            addConstraint(auxVar, L(bj->idx), 1.0);
            addConstraint(auxVar, W(bj->idx), 1.0);
            addConstraint(auxVar, L(bi->idx), -1.0);
            addConstraint(auxVar, B(bvIdx++), M);
            glp_set_row_bnds(lp, auxVar++, GLP_UP, 0.0, M);
        }
        // li + wi <= 1
        addConstraint(auxVar, L(bi->idx), 1.0);
        addConstraint(auxVar, W(bi->idx), 1.0);
        glp_set_row_bnds(lp, auxVar++, GLP_UP, 0.0, 1.0);

        // li >= 0
        glp_set_col_bnds(lp, L(bi->idx), GLP_LO, 0.0, 1.0);
        glp_set_obj_coef(lp, L(bi->idx), 0.0);
        // wi >= 0
        glp_set_col_bnds(lp, W(bi->idx), GLP_LO, 1.0 / total, 1.0);
        glp_set_obj_coef(lp, W(bi->idx), 1.0);
    }
    for (int i = 2 * N; i < 2 * N + numBV; i++) {
        glp_set_col_kind(lp, i + 1, GLP_BV);
        glp_set_obj_coef(lp, i + 1, 0.0);
    }

    glp_load_matrix(lp, ia.size() - 1, ia.data(), ja.data(), ar.data());

    // glp_simplex(lp, &parm);
    glp_iocp parm;
    glp_init_iocp(&parm);
    parm.presolve = GLP_ON;
    parm.msg_lev = GLP_MSG_ERR;
    parm.tm_lim = 10 * 1000;  // 10s time limit
    glp_intopt(lp, &parm);

    for (int i = 0; i < N; i++) {
        blocks[i].left = glp_mip_col_val(lp, 2 * i + 1);
        blocks[i].width = glp_mip_col_val(lp, 2 * i + 2);
    }
    glp_delete_prob(lp);
}

struct Input {
    int16_t startMin, endMin;
};

inline void computeInitialWidth(ScheduleBlock* end, int total) {
    for (auto block = blocks; block < end; block++) {
        block->left = static_cast<double>(block->depth) / total;
        block->width = 1.0 / total;
    }
}

/**
 * count the number of event blocks that are fixed, while also set their visited flag to be equal to fixed
 * */
inline int getFixedCount(ScheduleBlock* end) {
    int fixedCount = 0;
    for (auto block = blocks; block < end; block++)
        fixedCount += (block->visited = block->isFixed);
    return fixedCount;
}

// disable name-mangling for exported functions
extern "C" {

void setOptions(int _isTolerance, int _ISMethod, int _applyDFS,
                int _dfsTolerance, int _LPIters, int _LPModel, int _MILP) {
    isTolerance = _isTolerance;
    ISMethod = _ISMethod;
    applyDFS = _applyDFS;
    dfsTolerance = _dfsTolerance;
    LPIters = _LPIters;
    LPModel = _LPModel;
    MILP = _MILP;

    glp_init_smcp(&parm);
    parm.msg_lev = GLP_MSG_ERR;
}

/**
 * compute the width and left of the blocks
 * @param arr the array of start/end times of the blocks
 * @param N the number of blocks
 */
ScheduleBlock* compute(const Input* arr, int _N) {
    // ---------------------------- setup --------------------------------------
    N = _N;
    if (N > maxN) {  // TOOD: check for allocation failure
        // we need to allocate more memory.
        // the previous ptr may be NULL, so realloc will be equivalent to malloc in that case
        blocks = (ScheduleBlock*)realloc(blocks, N * sizeof(ScheduleBlock));

        // initialize newly allocated memory
        for (int i = maxN; i < N; i++) new ((void*)&blocks[i]) ScheduleBlock;
        blocksReordered = (ScheduleBlock**)realloc(blocksReordered, N * sizeof(ScheduleBlock*));
        blockBuffer = (ScheduleBlock**)realloc(blockBuffer, N * sizeof(ScheduleBlock*));
        idxMap = (int*)realloc(idxMap, N * sizeof(int));
        matrix = (bool*)realloc(matrix, N * N * sizeof(bool));
        maxN = N;
    }
    // for old arrays, use memset if needed
    // if they are overwritten anyway, no need to use memset
    memset(matrix, 0, N * N * sizeof(bool));
    r_sumSq = r_sum = 0.0;

    // initialize each block
    for (int i = 0; i < N; i++) {
        auto& block = blocks[i];
        blocksReordered[i] = &block;
        block.isFixed = false;
        block.visited = false;
        block.startMin = arr[i].startMin;
        block.endMin = arr[i].endMin;
        block.duration = block.endMin - block.startMin;
        block.idx = i;
        block.depth = 0;
        // they will be reassigned later anyway, no need to initialize
        // block.pathDepth = 0;
        // block.left = 0.0;
        // block.depth = 0.0;
        block.leftN.resize(0);
        block.rightN.resize(0);
        block.cleftN.resize(0);
        block.crightN.resize(0);
    }
    // ---------------------------- end setup --------------------------------------

    // STEP 1 the total number of rooms/columns needed
    int total = ISMethod == 1 ? intervalScheduling() : intervalScheduling2();

    if (MILP) {
        buildMILPModel(total);
        computeResult();
        return blocks;
    }

    auto end = blocks + N;
    if (total <= 1) {
        computeInitialWidth(end, total);
        computeResult();
        return blocks;
    }
    // STEP 2
    constructAdjList();
    // STEP 3
    condenseAdjList(end);
    if (applyDFS) {  // STEP 4
        dfsWidthExpansion();
        for (auto* node = blocks; node < end; node++)
            node->visited = false;
    } else {
        computeInitialWidth(end, total);
    }

    // STEP 5
    for (auto* block = blocks; block < end; block++) {
        if (block->visited) continue;
        double right = block->left + block->width;
        if (abs(right - 1.0) < DOUBLE_EPS)
            DFSFindFixedNumerical(block);
    }
    int prevFixedCount = getFixedCount(end);
    auto buildLPModel = LPModel == 2 ? buildLPModel2 : buildLPModel1;
    for (int i = 0; i < LPIters; i++) {
        // for each non-fixed component
        for (auto block = blocks; block < end; block++) {
            if (!block->visited)  // build and solve the lp model
                buildLPModel(BFS(block));
        }
        // reset the visited flag because DFSFindFixedNumerical also needs it
        for (auto block = blocks; block < end; block++)
            block->visited = block->isFixed;

        for (auto block = blocks; block < end; block++) {
            if (block->visited) continue;
            double right = block->left + block->width;
            if (abs(right - 1.0) < DOUBLE_EPS) {
                DFSFindFixedNumerical(block);
                continue;
            }
            for (auto n : block->rightN) {
                if (n->isFixed && abs(right - n->left) < DOUBLE_EPS) {
                    DFSFindFixedNumerical(block);
                    break;
                }
            }
        }
        int fixedCount = getFixedCount(end);
        if (fixedCount == prevFixedCount) {
            // EM_ASM({console.log("convergence reached at", $0)}, i);
            break;
        }
        prevFixedCount = fixedCount;
    }
    computeResult();
    return blocks;
}

double getSum() { return r_sum; }
double getSumSq() { return r_sumSq; }
}
}  // namespace Renderer