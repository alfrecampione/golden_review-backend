// Controllers for endpoints
class UserController {

    // Controller to get server information
    static async getInfo(request, reply) {
        return {
            message: 'Hi! Fastify server is working correctly',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        };
    }

    // Controller to get a user by ID
    static async getUserById(request, reply) {
        const { id } = request.params;

        // Here you can add validations and business logic
        if (!id || isNaN(id)) {
            return reply.code(400).send({
                error: 'Invalid user ID',
                message: 'The ID must be a valid number'
            });
        }

        return {
            message: 'User found',
            id: id,
            user: {
                id: id,
                name: `User ${id}`,
                email: `user${id}@example.com`,
                active: true
            }
        };
    }

    // Controller to create a new user
    static async createUser(request, reply) {
        const data = request.body;

        // Basic validations
        if (!data || Object.keys(data).length === 0) {
            return reply.code(400).send({
                error: 'Required data to create user',
                message: 'You must send data to create the user'
            });
        }

        // Simulate user creation
        const newUser = {
            id: Math.floor(Math.random() * 1000) + 1,
            ...data,
            createdAt: new Date().toISOString(),
            active: true
        };

        return reply.code(201).send({
            message: 'User created successfully',
            user: newUser
        });
    }

    // Controller to get all users
    static async getAllUsers(request, reply) {
        // Simulate getting users from database
        const users = [
            { id: 1, name: 'John Pérez', email: 'john@example.com', active: true },
            { id: 2, name: 'María García', email: 'maria@example.com', active: true },
            { id: 3, name: 'Carlos López', email: 'carlos@example.com', active: false }
        ];

        return {
            message: 'User list obtained',
            total: users.length,
            users: users
        };
    }

    // Controller to update a user
    static async updateUser(request, reply) {
        const { id } = request.params;
        const data = request.body;

        if (!id || isNaN(id)) {
            return reply.code(400).send({
                error: 'Invalid user ID'
            });
        }

        if (!data || Object.keys(data).length === 0) {
            return reply.code(400).send({
                error: 'Data required for update'
            });
        }

        return {
            message: 'User updated successfully',
            id: id,
            updatedData: data,
            updatedAt: new Date().toISOString()
        };
    }

    // Controller to delete a user
    static async deleteUser(request, reply) {
        const { id } = request.params;

        if (!id || isNaN(id)) {
            return reply.code(400).send({
                error: 'Invalid user ID'
            });
        }

        return {
            message: 'User deleted successfully',
            id: id,
            deletedAt: new Date().toISOString()
        };
    }
}

export default UserController;